import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Free-text fields validated at the Pydantic layer, same convention as
# app/models/host.py - adding a new provider kind/agent status never
# requires a migration.
AI_PROVIDER_KINDS = ("anthropic", "openai", "ollama")
AGENT_STATUSES = ("idle", "working", "waiting", "investigating", "error", "disabled")
TASK_STATUSES = ("queued", "running", "completed", "failed", "cancelled")
TASK_SOURCES = ("web", "nextcloud_talk", "schedule")
FINDING_SEVERITIES = ("info", "low", "medium", "high", "critical")
ACTION_STATUSES = ("pending", "approved", "rejected", "executed", "failed", "expired")
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
    max_tool_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    max_execution_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

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

    findings: Mapped[list["AIFinding"]] = relationship(back_populates="task", cascade="all, delete-orphan")


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


class AIUsage(Base):
    """
    One provider round trip's token usage. Written by worker_ai/ai/runtime.py
    right after every chat() call - not once per task - so a run that fails
    halfway (or a Coordinator's delegated sub-agents) still counts.
    Aggregated by GET /api/ai/usage for the AI Provider Usage panel; cost
    is computed there from a price table, never stored.
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
