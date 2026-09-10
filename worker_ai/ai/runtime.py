"""
Agent execution loop.

An "agent" is a DB row (app.models.ai.AIAgent) plus this shared loop, not
a bespoke class per agent - Coordinator/Linux/Monitoring differ only in
their system_prompt, allowed_tools, and provider config. The Coordinator
is told apart only by having "dispatch_to_agent" in its allowed_tools; the
loop then also offers that one extra tool, which recurses into this same
function for whichever specialist agent it names.

Tool-call authorization happens here in plain Python (host/environment
allowlists, tool allowlist) - never left to the model's own judgement, and
never influenced by anything a tool's *result* said (a hostname or log
line the model just read back is data, not a permission grant).

Every entry/exit and tool call also updates the agent's live state via
agent_state.set_agent_state - this is what drives the Ops Floor. It's
called here (not just in tasks.py) specifically so a Coordinator-delegated
sub-agent's own row updates too, exactly like a directly-asked agent's -
see set_agent_state's docstring.
"""
import json
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ai import AITask, AIAgent, AIUsage
from app.models.host import Host
from worker_ai.ai.actions import request_approval
from worker_ai.ai.agent_state import set_agent_state
from worker_ai.ai.memory import MEMORY_POLICY, MEMORY_SCHEMAS, memory_owner, note_context, recall, remember
from worker_ai.ai.providers import ProviderError, build_provider
from worker_ai.ai.tools import TOOL_REGISTRY, schemas_for
from worker_ai.ai.tools.exec_tools import TOOL_APPROVAL_LEVEL

DISPATCH_TOOL_NAME = "dispatch_to_agent"
MAX_DELEGATION_DEPTH = 2
_ACTIVITY_PREVIEW_LEN = 80

_DATA_SOURCE_BY_TOOL = {
    "get_server_metrics": "Prometheus",
    "get_alerts": "Alertmanager",
    "search_logs": "Loki",
    "get_service_status": "Ansible",
    "get_disk_usage": "Ansible",
    "get_running_processes": "Ansible",
    "get_patch_status": "Ops Center DB",
    "list_pending_patches": "Ops Center DB",
    "get_security_summary": "Ops Center DB",
    "list_top_vulnerabilities": "Ops Center DB",
    "list_containers": "Ops Center DB",
    "get_container_vulnerabilities": "Ops Center DB",
    "get_network_traffic_summary": "Traffic Map",
    "list_available_playbooks": "Ops Center DB",
    "get_container_logs": "Docker",
    "get_container_env_keys": "Docker",
    "list_docker_networks": "Docker",
    "web_fetch": "Web",
    "web_search": "Web",
    "list_repo_files": "Ops Center git repo",
    "read_repo_file": "Ops Center git repo",
    "search_code": "Ops Center git repo",
}


@dataclass
class RunResult:
    text: str
    tools_used: list[dict] = field(default_factory=list)
    agents_used: list[str] = field(default_factory=list)
    data_sources: list[str] = field(default_factory=list)


def _dispatch_schema(available_agents: list[str]) -> dict:
    return {
        "name": DISPATCH_TOOL_NAME,
        "description": (
            "Delegates a focused sub-question to one specialist agent and returns its answer. "
            f"Available agents: {', '.join(available_agents) or '(none enabled)'}."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "agent": {"type": "string", "enum": available_agents},
                "subtask": {"type": "string", "description": "The focused question to hand to that agent"},
            },
            "required": ["agent", "subtask"],
        },
    }


def _check_host_allowed(agent: AIAgent, db: Session, hostname: str | None) -> str | None:
    if hostname is None:
        return None
    if agent.allowed_hosts and hostname not in agent.allowed_hosts:
        return f"{hostname!r} is not in this agent's allowed_hosts"
    if agent.allowed_environments:
        host = db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none()
        if host is not None and host.environment not in agent.allowed_environments:
            return f"{hostname!r} is in environment {host.environment!r}, not permitted for this agent"
    return None


def _preview(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _ACTIVITY_PREVIEW_LEN else text[: _ACTIVITY_PREVIEW_LEN - 1] + "…"


def _record_usage(db: Session, agent: AIAgent, model: str, input_tokens: int, output_tokens: int, task_id: str | None) -> None:
    """One ai_usage row per provider round trip - committed immediately so a
    run that dies later still has its spend on record."""
    if not input_tokens and not output_tokens:
        return
    db.add(
        AIUsage(
            task_id=uuid.UUID(task_id) if task_id else None,
            agent_id=agent.id,
            provider_id=agent.provider_id,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
    )
    db.commit()


class TaskCancelled(Exception):
    """Control flow for a user-requested stop, never an agent error."""


def _check_cancelled(db: Session, task_id: str | None) -> None:
    if task_id and db.execute(select(AITask.status).where(AITask.id == task_id)).scalar_one_or_none() == "cancelled":
        raise TaskCancelled()


def run_agent(db: Session, agent: AIAgent, input_message: str, *, task_id: str | None = None, depth: int = 0) -> RunResult:
    try:
        _check_cancelled(db, task_id)
        return _run_agent(db, agent, input_message, task_id=task_id, depth=depth)
    except TaskCancelled:
        set_agent_state(db, agent, "idle" if agent.enabled else "disabled", "Stopped by user", None, task_id)
        raise
    except Exception as exc:
        # Also unwind delegated agents when a tool or database operation fails.
        db.rollback()
        set_agent_state(db, agent, "error", str(exc), None, task_id)
        raise


def _run_agent(db: Session, agent: AIAgent, input_message: str, *, task_id: str | None = None, depth: int = 0) -> RunResult:
    if depth > MAX_DELEGATION_DEPTH:
        return RunResult("Delegation went too deep - stopping to avoid a loop.")

    if agent.provider is None:
        set_agent_state(db, agent, "error", "No AI provider configured", None, task_id)
        return RunResult(f"{agent.name} has no AI provider configured.")

    set_agent_state(db, agent, "working", f"Investigating: {_preview(input_message)}", None, task_id)

    try:
        provider = build_provider(agent.provider)
    except ProviderError as exc:
        set_agent_state(db, agent, "error", str(exc), None, task_id)
        return RunResult(f"AI provider unavailable: {exc}")

    model = agent.model or agent.provider.default_model
    if not model:
        set_agent_state(db, agent, "error", "No model configured", None, task_id)
        return RunResult(f"{agent.name}'s provider has no model configured.")

    allowed_tools = list(agent.allowed_tools or [])
    is_coordinator = DISPATCH_TOOL_NAME in allowed_tools
    tool_schemas = schemas_for([t for t in allowed_tools if t != DISPATCH_TOOL_NAME])
    if is_coordinator:
        available = list(
            db.execute(
                select(AIAgent.slug).where(AIAgent.enabled.is_(True), AIAgent.slug != agent.slug)
            ).scalars()
        )
        tool_schemas = [_dispatch_schema(available)] + tool_schemas

    owner = memory_owner(db, task_id)
    if owner:
        tool_schemas += MEMORY_SCHEMAS
    system_prompt = agent.system_prompt + "\n" + MEMORY_POLICY + note_context(db, owner, agent.id)
    if not owner:
        system_prompt += "\nPersonal long-term memory is unavailable or disabled for this task. Do not claim to remember across conversations."

    messages: list[dict] = [{"role": "user", "content": input_message}]
    tools_used: list[dict] = []
    agents_used: list[str] = [agent.slug]
    data_sources: set[str] = set()

    for _ in range(max(1, agent.max_tool_calls)):
        _check_cancelled(db, task_id)
        try:
            result = provider.chat(system=system_prompt, messages=messages, tools=tool_schemas, model=model)
        except ProviderError as exc:
            set_agent_state(db, agent, "error", str(exc), None, task_id)
            return RunResult(f"AI provider unavailable: {exc}", tools_used, agents_used, sorted(data_sources))

        _record_usage(db, agent, model, result.input_tokens, result.output_tokens, task_id)
        _check_cancelled(db, task_id)
        messages.append(result.assistant_message)
        if result.stop_reason != "tool_use" or not result.tool_calls:
            set_agent_state(db, agent, "idle", None, None, task_id)
            if not result.text:
                # A truncation stop ("max_tokens" from Anthropic, "length"
                # from OpenAI) with no usable text/tool_calls means the model
                # got cut off mid-thought (e.g. a long dispatch subtask ate
                # the budget before it could finish) - that's a very
                # different situation from a clean empty answer and
                # deserves an honest message instead of a silent no-op, so
                # a Talk/chat user isn't left thinking nothing happened.
                fallback = (
                    "The response got cut off before finishing (ran out of output budget) - "
                    "please try again, ideally with a shorter or more specific request."
                    if result.stop_reason in ("max_tokens", "length")
                    else "(no answer returned)"
                )
                return RunResult(fallback, tools_used, agents_used, sorted(data_sources))
            return RunResult(result.text, tools_used, agents_used, sorted(data_sources))

        results_text = []
        for call in result.tool_calls:
            _check_cancelled(db, task_id)
            if owner and call.name in ("recall_memory", "remember_fact"):
                # Recheck the user's preference in case it changed during this run.
                db.expire_all()
                current_owner = memory_owner(db, task_id)
                if call.name == "recall_memory":
                    output = recall(db, current_owner, task_id, call.arguments.get("query", ""), agent.id)
                else:
                    output = remember(db, current_owner, task_id, call.arguments.get("key"), call.arguments.get("content"), agent_id=agent.id, scope=call.arguments.get("scope", "shared"))
                tools_used.append({"tool": call.name, "arguments": call.arguments})
                data_sources.add("Local personal memory")
            elif is_coordinator and call.name == DISPATCH_TOOL_NAME:
                sub_slug = call.arguments.get("agent")
                subtask = call.arguments.get("subtask") or input_message
                sub_agent = db.execute(select(AIAgent).where(AIAgent.slug == sub_slug)).scalar_one_or_none()
                if sub_agent is None or not sub_agent.enabled:
                    output = {"error": f"agent {sub_slug!r} is not available"}
                else:
                    set_agent_state(db, agent, "waiting", f"Waiting on {sub_agent.name}", None, task_id)
                    sub_result = run_agent(db, sub_agent, subtask, task_id=task_id, depth=depth + 1)
                    set_agent_state(db, agent, "working", f"Investigating: {_preview(input_message)}", None, task_id)
                    tools_used.extend(sub_result.tools_used)
                    agents_used.extend(sub_result.agents_used)
                    data_sources.update(sub_result.data_sources)
                    output = {"agent": sub_slug, "answer": sub_result.text}
            elif call.name in allowed_tools and call.name in TOOL_APPROVAL_LEVEL:
                # Write/execute tool - never runs here. Creates a pending
                # AIAction; the real execution only ever happens later,
                # from execute_action_task, after a human approves it.
                hostname = call.arguments.get("hostname")
                denial = _check_host_allowed(agent, db, hostname)
                if denial:
                    output = {"error": denial}
                else:
                    output = request_approval(
                        db, agent, call.name, call.arguments, task_id, f"Requested during: {_preview(input_message)}"
                    )
                    tools_used.append({"tool": call.name, "arguments": call.arguments})
            elif call.name in allowed_tools and call.name in TOOL_REGISTRY:
                hostname = call.arguments.get("hostname")
                denial = _check_host_allowed(agent, db, hostname)
                if denial:
                    output = {"error": denial}
                else:
                    set_agent_state(db, agent, "investigating", f"{call.name}({hostname or ''})", hostname, task_id)
                    output = TOOL_REGISTRY[call.name](**call.arguments)
                    tools_used.append({"tool": call.name, "arguments": call.arguments})
                    if call.name in _DATA_SOURCE_BY_TOOL:
                        data_sources.add(_DATA_SOURCE_BY_TOOL[call.name])
            else:
                output = {"error": f"tool {call.name!r} is not permitted for this agent"}
            results_text.append(json.dumps(output, default=str))

        messages.extend(provider.tool_result_messages(result.tool_calls, results_text))

    set_agent_state(db, agent, "idle", None, None, task_id)
    return RunResult(
        "Investigation stopped after reaching the maximum number of tool calls without a final answer.",
        tools_used,
        agents_used,
        sorted(data_sources),
    )
