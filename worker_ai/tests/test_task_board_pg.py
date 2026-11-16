"""Coordinated investigation end to end on real PostgreSQL (migrated schema).

The model is a scripted fake, so this checks Ops Center's orchestration,
not model quality: planning, parallel delegation on separate sessions, a
failing specialist, shared findings reused by a later task, outcome and
resume from the saved board, tool proposals and the developer patch.

    BOARD_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_board_test?host=/path/to/socket' \\
      PYTHONPATH=backend:. pytest worker_ai/tests/test_task_board_pg.py
(the database must be migrated to head first: alembic upgrade head).
"""
import json
import os
import threading
import uuid
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.models.ai import AIAgent, AIFinding, AIProvider, AITask, AIToolProposal, AIWorkItem
from app.models.user import User
from worker_ai.ai import board
from worker_ai.ai import runtime as r
from worker_ai.ai.providers.base import ProviderError, ProviderResult, ToolCall

URL = os.environ.get("BOARD_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_board_test" not in URL, reason="needs BOARD_TEST_DATABASE_URL for ops_board_test")


class FakeModel:
    """Stateless per call, so parallel specialists can share it safely."""

    def __init__(self):
        self.calls = []
        self.max_tokens = {}
        self.lock = threading.Lock()

    def tool_result_messages(self, calls, results):
        return [{"role": "tool", "tool_call_id": c.id, "name": c.name, "content": t} for c, t in zip(calls, results)]

    def chat(self, *, system, messages, tools, model, **options):
        names = {t["name"] for t in tools}
        with self.lock:
            self.max_tokens[system.split(":")[0].split(".")[0]] = options.get("max_tokens")
            self.calls.append((system.split(".")[0], [t["name"] for t in tools]))
        tool_turns = [m for m in messages if m.get("role") == "tool"]
        if system.startswith("You are the Coordinator"):
            return self._coordinator(messages, tool_turns, names)
        if system.startswith("You are the Network"):
            raise ProviderError("Mistral API call failed: 503")
        if system.startswith("You are the Monitoring"):
            if not tool_turns:
                return self._tools(("get_alerts", {}), ("record_finding", {
                    "kind": "fact", "system": "nextcloud@docker-host-02", "statement": "Redis latency is high on docker-host-02",
                    "evidence": "alert RedisLatencyHigh firing", "source": "get_alerts"}))
            return self._answer("Nextcloud is slow because Redis latency is high (alert RedisLatencyHigh).")
        if system.startswith("You are the Developer"):
            if not tool_turns:
                return self._tools(("submit_patch", {"diff": "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n",
                                                     "notes": "Adds x; unverified"}))
            return self._answer("Patch submitted.")
        return self._answer("ok")

    def _coordinator(self, messages, tool_turns, names):
        question = messages[0]["content"]
        if "Resume this investigation" in question:
            return self._answer("Resumed with the saved board: " + str("Redis latency" in question))
        if "second look" in question:
            if not tool_turns:
                return self._tools(("recall_memory", {"query": "nextcloud slow"}))
            return self._answer("Memory: " + tool_turns[-1]["content"])
        if not tool_turns:
            return self._tools(("plan_work", {"items": [
                {"key": "logs", "agent": "monitoring", "subtask": "Why is Nextcloud slow? Check metrics, alerts and logs."},
                {"key": "vpn", "agent": "network", "subtask": "Why does the VPN drop connections?"}]}))
        if len(tool_turns) == 1:
            items = json.loads(tool_turns[0]["content"])["items"]
            return self._tools(*[(r.DISPATCH_TOOL_NAME, {"agent": i["agent"], "subtask": s, "work_item": i["work_item"]})
                                 for i, s in zip(items, ["Why is Nextcloud slow? Check metrics, alerts and logs.",
                                                         "Why does the VPN drop connections?"])])
        return self._answer("Cause: Redis latency. VPN: network check failed, still open. " + " | ".join(t["content"][:200] for t in tool_turns[1:]))

    @staticmethod
    def _tools(*calls):
        return ProviderResult(text="", stop_reason="tool_use",
                              tool_calls=[ToolCall(id=f"c{uuid.uuid4().hex[:6]}", name=n, arguments=a) for n, a in calls],
                              assistant_message={"role": "assistant", "content": ""})

    @staticmethod
    def _answer(text):
        return ProviderResult(text=text, stop_reason="stop", assistant_message={"role": "assistant", "content": text})


@pytest.fixture
def env():
    engine = create_engine(URL)
    assert engine.url.database == "ops_board_test", "Refusing to modify any other database"
    maker = sessionmaker(bind=engine, expire_on_commit=False, class_=Session)
    with maker() as db:
        for table in ("ai_work_items", "ai_tool_proposals", "ai_findings", "ai_usage", "ai_actions", "ai_tasks"):
            db.execute(text(f"DELETE FROM {table}"))
        db.execute(delete(User).where(User.username == "board-test"))
        provider = db.execute(select(AIProvider).where(AIProvider.slug == "board-test")).scalar_one_or_none()
        if provider is None:
            provider = AIProvider(slug="board-test", kind="ollama", display_name="Fake", enabled=True, default_model="fake")
            db.add(provider)
            db.flush()
        user = User(username="board-test", password_hash="x", role="admin", is_active=True)
        db.add(user)
        db.flush()
        for agent in db.execute(select(AIAgent)).scalars():
            agent.provider_id, agent.enabled, agent.max_execution_seconds = provider.id, True, 120
        coordinator = db.execute(select(AIAgent).where(AIAgent.slug == "coordinator")).scalar_one()
        coordinator.allowed_tools = [r.DISPATCH_TOOL_NAME]  # no MCP tools: no grants in this database
        monitoring = db.execute(select(AIAgent).where(AIAgent.slug == "monitoring")).scalar_one()
        monitoring.allowed_tools = ["get_alerts"]
        db.commit()
        model = FakeModel()
        fake_alerts = lambda **_: {"available": True, "alerts": [{"name": "RedisLatencyHigh", "host": "docker-host-02"}]}
        with patch("worker_ai.db.SessionLocal", maker), patch("worker_ai.tasks.SessionLocal", maker), \
             patch.object(r, "build_provider", return_value=model), patch("worker_ai.ai.agent_state.publish_agent_event"), \
             patch.dict(r.TOOL_REGISTRY, {"get_alerts": fake_alerts}):
            yield type("Env", (), {"db": db, "maker": maker, "user": user, "model": model, "coordinator": coordinator})
    engine.dispose()


def _task(env, agent, message, **extra):
    task = AITask(agent_id=agent.id, owner_user_id=env.user.id, requested_by="board-test", source=extra.pop("source", "web"),
                  input_message=message, status="queued", **extra)
    env.db.add(task)
    env.db.commit()
    return task


def _run(env, task):
    from worker_ai.tasks import _run_agent_task
    _run_agent_task(str(task.id), None)
    env.db.expire_all()
    return env.db.get(AITask, task.id)


def test_coordinator_plans_delegates_in_parallel_and_survives_a_failing_specialist(env):
    with patch.object(r, "_dispatch_parallel", wraps=r._dispatch_parallel) as fanout:
        task = _run(env, _task(env, env.coordinator, "Undersøk hvorfor Nextcloud er treg og hvorfor VPN har tilkoblingsproblemer."))
    assert fanout.call_count == 1 and len(fanout.call_args.args[1]) == 2
    assert task.status == "completed" and task.outcome == "inconclusive"
    assert "Redis latency" in task.response_message
    items = {i.agent_slug: i for i in env.db.execute(select(AIWorkItem).where(AIWorkItem.task_id == task.id)).scalars()}
    assert set(items) == {"monitoring", "network"}
    assert items["monitoring"].status == "completed" and "get_alerts" in items["monitoring"].tools
    assert items["network"].status == "failed" and "ProviderError" in items["network"].result
    assert {"monitoring", "coordinator"} <= set(task.agents_used)
    finding = env.db.execute(select(AIFinding).where(AIFinding.task_id == task.id)).scalar_one()
    assert finding.kind == "fact" and finding.system == "nextcloud@docker-host-02" and finding.stale_after > finding.observed_at
    # The coordinator was offered the board tools, specialists only findings/proposals.
    coordinator_tools = next(tools for name, tools in env.model.calls if name.startswith("You are the Coordinator"))
    assert {"plan_work", "record_finding", "propose_tool", r.DISPATCH_TOOL_NAME} <= set(coordinator_tools)
    monitoring_tools = next(tools for name, tools in env.model.calls if name.startswith("You are the Monitoring"))
    assert "plan_work" not in monitoring_tools and "record_finding" in monitoring_tools


def test_later_task_reuses_shared_findings_and_resume_continues_from_board(env):
    first = _run(env, _task(env, env.coordinator, "Hvorfor er Nextcloud treg?"))
    second = _run(env, _task(env, env.coordinator, "Take a second look at nextcloud"))
    assert "Redis latency is high" in second.response_message and '"stale": false' in second.response_message
    resumed = _run(env, _task(env, env.coordinator, "Resume: Hvorfor er Nextcloud treg?", resumed_from=first.id))
    assert resumed.response_message == "Resumed with the saved board: True"


def test_identical_findings_update_one_row_and_secrets_are_refused(env):
    task = _task(env, env.coordinator, "x")
    agent = env.coordinator
    args = {"kind": "hypothesis", "system": "vpn.example.com", "statement": "SNI does not match the proxy host"}
    assert board.record_finding(env.db, task, agent, args)["saved"]
    assert board.record_finding(env.db, task, agent, {**args, "evidence": "curl: tlsv1 unrecognized name"})["saved"]
    rows = env.db.execute(select(AIFinding).where(AIFinding.system == "vpn.example.com")).scalars().all()
    assert len(rows) == 1 and "unrecognized name" in rows[0].description
    assert "error" in board.record_finding(env.db, task, agent, {**args, "statement": "password: hunter2"})


def test_work_items_refuse_loops_and_unfinished_dependencies(env):
    task = _task(env, env.coordinator, "x")
    planned = board.plan(env.db, task, [{"key": "a", "agent": "monitoring", "subtask": "A"},
                                        {"key": "b", "agent": "linux", "subtask": "B", "depends_on": ["a"]}], ["monitoring", "linux"])
    ids = {i["key"]: i["work_item"] for i in planned["items"]}
    assert board.claim(env.db, task.id, ids["b"], "linux", "B")[1] == "Dispatch the items it depends on first"
    assert board.claim(env.db, task.id, ids["a"], "linux", "A")[1] == "Work item belongs to monitoring"
    row, _ = board.claim(env.db, task.id, ids["a"], "monitoring", "A")
    board.fail(env.db, row, "x")
    board.claim(env.db, task.id, ids["a"], "monitoring", "A")
    assert "ran twice" in board.claim(env.db, task.id, ids["a"], "monitoring", "A")[1]
    assert "error" in board.plan(env.db, task, [{"key": "z", "agent": "developer", "subtask": "Z"}], ["monitoring", "linux"])
    # A dispatch without the item id consumes the queued planned item instead of adding a duplicate.
    adhoc, _ = board.claim(env.db, task.id, None, "linux", "B, reworded")
    assert str(adhoc.id) == ids["b"] and adhoc.status == "running"


def test_missing_capability_becomes_one_proposal_and_developer_only_submits_a_patch(env):
    task = _task(env, env.coordinator, "x")
    spec = {"title": "tls_check diagnostic", "missing": "No TLS/SNI check", "reason": "vpn.example.com fails with unrecognized name",
            "design": "curl -v --resolve, read-only", "security": "read-only, validated URL", "permissions": "run_diagnostic scope",
            "tests": "unit tests for argv"}
    first = board.propose(env.db, task, env.coordinator, spec)
    again = board.propose(env.db, task, env.coordinator, spec)
    assert again["proposal"] == first["proposal"] and "already exists" in again["note"]
    proposal = env.db.get(AIToolProposal, uuid.UUID(first["proposal"]))
    developer = env.db.execute(select(AIAgent).where(AIAgent.slug == "developer")).scalar_one()
    assert set(developer.allowed_tools) == {"list_repo_files", "read_repo_file", "search_code"}
    dev_task = _task(env, developer, "Implement the approved proposal", source="development")
    proposal.status, proposal.dev_task_id = "in_development", dev_task.id
    env.db.commit()
    done = _run(env, dev_task)
    env.db.refresh(proposal)
    assert done.status == "completed" and proposal.status == "ready_for_review" and proposal.patch.startswith("diff --git")
    assert env.model.max_tokens.get("You are the Developer agent") == 8192
    developer_tools = next(tools for name, tools in env.model.calls if name.startswith("You are the Developer"))
    assert "submit_patch" in developer_tools and not {"run_shell_command", "run_diagnostic", r.DISPATCH_TOOL_NAME} & set(developer_tools)


def test_coordinator_cannot_dispatch_to_the_developer(env):
    assert "developer" not in r.dispatch_targets(env.db, env.coordinator)


def test_development_run_without_patch_hands_the_proposal_back(env):
    developer = env.db.execute(select(AIAgent).where(AIAgent.slug == "developer")).scalar_one()
    task = _task(env, env.coordinator, "x")
    proposal = AIToolProposal(id=uuid.uuid4(), task_id=task.id, title="file_grep", details={}, status="in_development")
    env.db.add(proposal)
    env.db.commit()
    dev_task = _task(env, developer, "Investigate only", source="development")
    proposal.dev_task_id = dev_task.id
    env.db.commit()
    with patch.object(env.model, "chat", return_value=FakeModel._answer("I looked around")):
        _run(env, dev_task)
    env.db.refresh(proposal)
    assert proposal.status == "proposed" and proposal.patch_notes.endswith("ended without a patch: finished without submitting")
    assert "I looked around" not in proposal.patch_notes


def test_development_run_out_of_tool_budget_still_gets_to_submit(env):
    developer = env.db.execute(select(AIAgent).where(AIAgent.slug == "developer")).scalar_one()
    budget = developer.max_tool_calls
    developer.max_tool_calls = 2
    dev_task = _task(env, developer, "Implement", source="development")
    proposal = AIToolProposal(id=uuid.uuid4(), title="budget", details={}, status="in_development", dev_task_id=dev_task.id)
    env.db.add(proposal)
    env.db.commit()
    offered = []
    diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+x\n"

    def chat(*, system, messages, tools, model, **options):
        offered.append([t["name"] for t in tools])
        tool_turns = [m for m in messages if m.get("role") == "tool"]
        if not tool_turns:  # one batch larger than the whole budget
            return FakeModel._tools(*[("search_code", {"query": f"q{i}"}) for i in range(3)])
        if len(offered) == 2:
            return FakeModel._tools(("submit_patch", {"diff": diff, "notes": "unverified"}))
        return FakeModel._answer("Patch submitted.")

    try:
        with patch.object(env.model, "chat", side_effect=chat):
            done = _run(env, dev_task)
    finally:
        developer.max_tool_calls = budget
        env.db.commit()
    env.db.refresh(proposal)
    assert done.status == "completed" and proposal.status == "ready_for_review"
    assert offered[1] == ["submit_patch"]  # the closing turn offers nothing else
    assert all(t["tool"] != "search_code" for t in done.tools_used)


def test_developer_can_submit_a_patch_file_by_file(env):
    developer = env.db.execute(select(AIAgent).where(AIAgent.slug == "developer")).scalar_one()
    dev_task = _task(env, developer, "Implement", source="development")
    proposal = AIToolProposal(id=uuid.uuid4(), title="two files", details={}, status="in_development", dev_task_id=dev_task.id)
    env.db.add(proposal)
    env.db.commit()
    part = "diff --git a/{0} b/{0}\n--- a/{0}\n+++ b/{0}\n@@ -0,0 +1 @@\n+x\n"
    first = board.submit_patch(env.db, dev_task, {"diff": part.format("worker_ai/ai/tools/a.py"), "notes": "tool", "final": False})
    assert first["status"] == "in_development"
    done = board.submit_patch(env.db, dev_task, {"diff": part.format("worker_ai/tests/test_a.py"), "notes": "tests; unverified", "final": True})
    env.db.refresh(proposal)
    assert done["status"] == "ready_for_review" and proposal.patch.count("diff --git") == 2
    assert proposal.patch_notes == "tool\ntests; unverified"


def test_unfinished_multi_part_patch_is_discarded_with_the_run(env):
    developer = env.db.execute(select(AIAgent).where(AIAgent.slug == "developer")).scalar_one()
    dev_task = _task(env, developer, "Implement", source="development")
    proposal = AIToolProposal(id=uuid.uuid4(), title="half", details={}, status="in_development", dev_task_id=dev_task.id,
                              patch="diff --git a/x b/x\n")
    env.db.add(proposal)
    env.db.commit()
    board.release_unfinished_proposal(env.db, dev_task)
    assert proposal.status == "proposed" and proposal.patch is None and "partial patch discarded" in proposal.patch_notes
