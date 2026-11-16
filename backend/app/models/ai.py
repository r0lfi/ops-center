import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, and_, func, select
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Free-text fields validated at the Pydantic layer, same convention as
# app/models/host.py - adding a new provider kind/agent status never
# requires a migration.
# "openai_compatible" is a self-hosted server speaking the OpenAI chat API
# (e.g. a local llama.cpp-style endpoint): base_url required, key optional,
# priced as zero like Ollama.
AI_PROVIDER_KINDS = ("anthropic", "openai", "mistral", "ollama", "openai_compatible")
# "native" agents run in ops-ai-worker. "external" agents run elsewhere (for
# example an opencode session on an admin host) and only report their state.
AI_AGENT_RUNTIMES = ("native", "external")
# A personal agent (nova) talks to its owner and never touches
# infrastructure itself: these are the only tools it may be configured with
# or offered (memory tools come from the task owner, not this list). Infra
# work goes through dispatch_to_agent to its allowed targets, whose own
# approval flow is unchanged. Enforced in the API and again in the runtime.
PERSONAL_AGENT_TOOLS = ("web_search", "web_fetch", "dispatch_to_agent")
# A personal agent's proactive routine runs (source="routine") read only: no delegation.
ROUTINE_TOOLS = ("web_search", "web_fetch")
AGENT_STATUSES = ("idle", "working", "waiting", "investigating", "error", "disabled")
TASK_STATUSES = ("queued", "running", "completed", "failed", "cancelled")
TASK_SOURCES = ("web", "talk", "nextcloud_talk", "schedule", "collaboration", "incident", "routine")
FINDING_SEVERITIES = ("info", "low", "medium", "high", "critical")
ACTION_STATUSES = ("pending", "approved", "executing", "rejected", "executed", "failed", "expired")
ACTION_RISKS = ("low", "medium", "high")


class AIProvider(Base):
    __tablename__ = "ai_providers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    slug: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Override endpoint - used for Ollama (LAN address) or an OpenAI-
    # compatible third party. NULL means "use the provider's public API".
    base_url: Mapped[str | None] = mapped_column(String(500))
    default_model: Mapped[str | None] = mapped_column(String(200))
    # Path relative to secrets_root, same pattern as Credential.secret_path
    # (app/models/host.py) - the raw API key is never stored in the
    # database. NULL for providers that need no key (Ollama).
    secret_path: Mapped[str | None] = mapped_column(String(500))
    # The same key, encrypted (app/core/provider_keys.py). Every node can
    # read it, unlike the key file, which exists only on the node that saved
    # it. The worker prefers it; secret_path still marks "a key is set".
    # Never returned by the API.
    encrypted_key: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    agents: Mapped[list["AIAgent"]] = relationship(back_populates="provider")


class AIAgent(Base):
    __tablename__ = "ai_agents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    slug: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    responsibility: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="idle", index=True)
    current_task: Mapped[str | None] = mapped_column(String(500))
    error_message: Mapped[str | None] = mapped_column(Text)

    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_providers.id", ondelete="SET NULL")
    )
    provider: Mapped[AIProvider | None] = relationship(back_populates="agents")
    # Overrides provider.default_model when set.
    model: Mapped[str | None] = mapped_column(String(200))

    system_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Tool names this agent is permitted to call - enforced in the tool
    # dispatch layer (worker_ai/ai/runtime.py), never left to the model's
    # own discretion.
    allowed_tools: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Empty list = no restriction (all hosts/environments allowed).
    allowed_hosts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    allowed_environments: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    autonomy_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_tool_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=64)
    max_execution_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    runtime: Mapped[str] = mapped_column(String(20), nullable=False, default="native", server_default="native")
    # Slugs this agent may delegate to with dispatch_to_agent. NULL keeps the
    # original behaviour: every enabled native agent except personal ones.
    allowed_dispatch_targets: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Personal agents (nova) hold one owner's private context: no other
    # agent may dispatch to them, their tasks are visible only to the task
    # owner, live activity is shown generically and tools are limited to
    # PERSONAL_AGENT_TOOLS.
    personal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tasks: Mapped[list["AITask"]] = relationship(back_populates="agent")
    findings: Mapped[list["AIFinding"]] = relationship(back_populates="agent")


class AITask(Base):
    __tablename__ = "ai_tasks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent: Mapped[AIAgent] = relationship(back_populates="tasks")

    # Plain username, not a users.id FK - matches AnsibleJob.user's existing
    # convention (app/models/job.py), and keeps room for non-user sources
    # (source="schedule") that have no requesting user at all.
    requested_by: Mapped[str | None] = mapped_column(String(100))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="web")

    # Groups a sequence of related tasks into one conversation - e.g.
    # "talk:<room token>" for a Talk room, "web:<agent slug>:<uuid>" for a
    # chat-page thread. Null means what it always meant: one independent
    # question with no history. See worker_ai/tasks.py's
    # _build_contextual_message for how this is used.
    conversation_key: Mapped[str | None] = mapped_column(String(200), index=True)

    input_message: Mapped[str] = mapped_column(Text, nullable=False)
    response_message: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued", index=True)
    celery_task_id: Mapped[str | None] = mapped_column(String(100))
    error_message: Mapped[str | None] = mapped_column(Text)

    # Investigation transparency (spec: "never hide operational actions
    # behind vague statements") - exactly which agents/tools/sources backed
    # this answer, shown verbatim in the UI.
    agents_used: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    tools_used: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    data_sources: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    confidence: Mapped[int | None] = mapped_column(Integer)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    # What the run established, separate from the execution status: one of
    # TASK_OUTCOMES, set by the worker when the run ends.
    outcome: Mapped[str | None] = mapped_column(String(30))
    # A resumed investigation points at the task whose saved state it continues.
    resumed_from: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"))

    findings: Mapped[list["AIFinding"]] = relationship(back_populates="task", cascade="all, delete-orphan")


TASK_OUTCOMES = ("completed", "inconclusive", "blocked", "waiting_for_approval", "failed")
WORK_ITEM_STATUSES = ("queued", "running", "waiting_for_agent", "waiting_for_approval", "blocked",
                      "completed", "failed", "inconclusive")
FINDING_KINDS = ("fact", "hypothesis", "ruled_out", "resolution")


class AIWorkItem(Base):
    """One delegated piece of an investigation: the coordinator's task board.

    Written as each delegation starts and ends, so it is also the checkpoint
    a resumed investigation continues from.
    """
    __tablename__ = "ai_work_items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_slug: Mapped[str] = mapped_column(String(50), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="queued")
    depends_on: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    result: Mapped[str | None] = mapped_column(Text)
    tools: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AIToolProposal(Base):
    """A missing capability an agent found, for a human to approve or reject.

    Approval allows development only: the developer agent writes a patch,
    a person applies it on a branch, and production rollout is a separate
    reviewed release.
    """
    __tablename__ = "ai_tool_proposals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"), index=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="SET NULL"))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="proposed", index=True)
    patch: Mapped[str | None] = mapped_column(Text)
    patch_notes: Mapped[str | None] = mapped_column(Text)
    dev_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"))
    decided_by: Mapped[str | None] = mapped_column(String(100))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AIFinding(Base):
    __tablename__ = "ai_findings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent: Mapped[AIAgent] = relationship(back_populates="findings")
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="CASCADE"), index=True
    )
    task: Mapped[AITask | None] = relationship(back_populates="findings")
    host_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="SET NULL"), index=True
    )

    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="info")
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    # Shared operational memory (record_finding): what kind of statement it
    # is, about which system, from which tool, and when it stops being current.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="fact", server_default="fact")
    system: Mapped[str | None] = mapped_column(String(200), index=True)
    source: Mapped[str | None] = mapped_column(String(100))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    fingerprint: Mapped[str | None] = mapped_column(String(64), unique=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    stale_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AIUsage(Base):
    """
    One provider round trip's token usage. Written by worker_ai/ai/runtime.py
    right after every chat() call - not once per task - so a run that fails
    halfway (or a Coordinator's delegated sub-agents) still counts.
    Aggregated by GET /api/ai/usage for the AI Provider Usage panel. Linked
    paid calls use their reservation's stored settled estimate; unlinked
    historical rows retain a labeled estimate from the reviewed price table.
    """

    __tablename__ = "ai_usage"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"), index=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_providers.id", ondelete="SET NULL"), index=True
    )
    # Exact admission provenance, including requests that finish after a
    # weekly boundary. Legacy/local rows remain nullable and unmodified.
    reservation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_budget_reservations.id", ondelete="RESTRICT"),
        unique=True, index=True,
    )
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class AIAction(Base):
    """
    A write/execute operation an agent wants to perform, gated on human
    approval - the LLM never causes this table's `tool`/`arguments` to run
    directly (see worker_ai/ai/actions.py's request_approval): calling one
    of these tools only ever creates a pending row here. Execution happens
    from a completely separate code path (worker_ai/tasks.py's
    execute_action_task), triggered only by POST .../approve, which
    re-validates role/level/expiry/status before touching anything.
    """

    __tablename__ = "ai_actions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    request_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)

    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent: Mapped[AIAgent] = relationship()
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"), index=True
    )
    host_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="SET NULL"), index=True
    )

    action: Mapped[str] = mapped_column(String(500), nullable=False)
    tool: Mapped[str] = mapped_column(String(100), nullable=False)
    arguments: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    approval_level: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    risk: Mapped[str] = mapped_column(String(20), nullable=False, default="medium")
    reason: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="web")
    requested_by: Mapped[str | None] = mapped_column(String(100))
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True)
    approved_by: Mapped[str | None] = mapped_column(String(100))

    result: Mapped[dict | None] = mapped_column(JSONB)

    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AIChangeReview(Base):
    """Append-only record of human decisions on a developer-agent change.

    approve / request_changes / reject are review decisions; released,
    release_failed and rolled_back record what a person did with an approved
    patch through the reviewed release process. An approval names the exact
    patch (SHA-256); a different patch is never covered by it.
    """
    __tablename__ = "ai_change_reviews"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    proposal_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tool_proposals.id", ondelete="CASCADE"), nullable=False, index=True)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    patch_sha256: Mapped[str | None] = mapped_column(String(64))
    comment: Mapped[str | None] = mapped_column(Text)
    release_ref: Mapped[str | None] = mapped_column(String(200))
    decided_by: Mapped[str] = mapped_column(String(100), nullable=False)
    decided_by_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


# A task still "running" after its agent's time budget plus this margin was
# abandoned (worker restart, lost message): it no longer keeps its agent busy.
OPEN_TASK_GRACE_SECONDS = 600
QUEUED_TASK_MAX_HOURS = 6


def open_task_counts(exclude_task_id=None):
    """Running and queued tasks per agent id: the one rule for "is this agent busy".

    Used by the API (Ops Floor, AI overview) and by the worker when a task
    ends, so one agent with many tasks is one busy agent, never many, and is
    not marked idle while other tasks of it still run.
    """
    started = func.coalesce(AITask.started_at, AITask.created_at)
    running = and_(AITask.status == "running",
                   started > func.now() - func.make_interval(0, 0, 0, 0, 0, 0, AIAgent.max_execution_seconds + OPEN_TASK_GRACE_SECONDS))
    queued = and_(AITask.status == "queued",
                  AITask.created_at > func.now() - func.make_interval(0, 0, 0, 0, QUEUED_TASK_MAX_HOURS))
    query = (select(AITask.agent_id, func.count().filter(running).label("running"), func.count().filter(queued).label("queued"))
             .join(AIAgent, AIAgent.id == AITask.agent_id)
             .where(AITask.status.in_(("running", "queued")))
             .group_by(AITask.agent_id))
    if exclude_task_id is not None:
        query = query.where(AITask.id != exclude_task_id)
    return query
