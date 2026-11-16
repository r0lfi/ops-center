import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.ai import AI_PROVIDER_KINDS

_Slug = Annotated[str, Field(min_length=1, max_length=50, pattern=r"^[a-z][a-z0-9_-]*$")]


class AIProviderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    kind: str
    display_name: str
    base_url: str | None
    default_model: str | None
    has_key: bool = False
    enabled: bool
    updated_at: datetime


class AIProviderCreate(BaseModel):
    slug: str
    kind: str
    display_name: str
    base_url: str | None = None
    default_model: str | None = None

    def validate_kind(self) -> None:
        if self.kind not in AI_PROVIDER_KINDS:
            raise ValueError(f"kind must be one of {AI_PROVIDER_KINDS}")


class AIProviderUpdate(BaseModel):
    display_name: str | None = None
    base_url: str | None = None
    default_model: str | None = None
    enabled: bool | None = None


class AIProviderKeySet(BaseModel):
    api_key: str = Field(min_length=1)


class AIAgentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    name: str
    description: str | None
    responsibility: str | None
    status: str
    current_task: str | None
    error_message: str | None
    provider_id: uuid.UUID | None
    model: str | None
    system_prompt: str
    allowed_tools: list[str]
    allowed_hosts: list[str]
    allowed_environments: list[str]
    autonomy_level: int
    max_tool_calls: int
    max_execution_seconds: int
    enabled: bool
    runtime: str = "native"
    allowed_dispatch_targets: list[str] | None = None
    personal: bool = False
    last_activity_at: datetime | None
    updated_at: datetime
    # Open tasks of this agent (app.models.ai.open_task_counts): one agent with
    # many tasks is still one agent. Filled by GET /ai/agents.
    running_tasks: int = 0
    queued_tasks: int = 0


class AIAgentCreate(BaseModel):
    slug: str = Field(min_length=1, max_length=50, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    responsibility: str | None = None
    provider_id: uuid.UUID | None = None
    model: str | None = None
    system_prompt: str = ""
    allowed_tools: list[str] = Field(default_factory=list)
    allowed_hosts: list[str] = Field(default_factory=list)
    allowed_environments: list[str] = Field(default_factory=list)
    autonomy_level: int = 0
    max_tool_calls: int = Field(default=64, ge=1, le=256)
    max_execution_seconds: int = Field(default=90, ge=10, le=1800)  # below Celery's 2400 s hard limit
    enabled: bool = True
    # "external": runs outside Ops Center (e.g. opencode) and only reports
    # its state through POST /api/ai/agents/{id}/report. Fixed at creation.
    runtime: Literal["native", "external"] = "native"
    # None: may dispatch to every enabled native, non-personal agent.
    allowed_dispatch_targets: list[_Slug] | None = Field(default=None, max_length=50)
    # Fixed at creation, like runtime - see AIAgent.personal.
    personal: bool = False


class AIAgentUpdate(BaseModel):
    description: str | None = None
    provider_id: uuid.UUID | None = None
    model: str | None = None
    system_prompt: str | None = None
    allowed_tools: list[str] | None = None
    allowed_hosts: list[str] | None = None
    allowed_environments: list[str] | None = None
    autonomy_level: int | None = None
    max_tool_calls: int | None = Field(default=None, ge=1, le=256)
    max_execution_seconds: int | None = Field(default=None, ge=10, le=1800)
    enabled: bool | None = None
    allowed_dispatch_targets: list[_Slug] | None = Field(default=None, max_length=50)


class AgentStatusReport(BaseModel):
    """Live state reported by an external agent (runtime="external")."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["idle", "working", "error"]
    activity: str | None = Field(default=None, max_length=500)
    target: str | None = Field(default=None, max_length=200)


class AskContextItem(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    value: str = Field(min_length=1, max_length=200)


class AskContext(BaseModel):
    """What the user was looking at: the page, its filters and selected object ids.

    Identifiers only, never page data: the agent reads data with its own
    tools and permissions. Shown to the user before sending, removable.
    """
    page: str = Field(min_length=1, max_length=80)
    path: str = Field(min_length=1, max_length=300, pattern=r"^/")
    items: list[AskContextItem] = Field(default_factory=list, max_length=12)


class AskRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    agent: str = "coordinator"
    # Groups this and future asks into one remembered conversation - see
    # app.models.ai.AITask.conversation_key. Omitted means what it always
    # meant: a standalone question with no history.
    conversation_key: str | None = Field(default=None, max_length=200)


class AskWithContextRequest(AskRequest):
    """Ask Ops AI from the web UI, optionally with the page the question came from."""
    context: AskContext | None = None


class AITaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_id: uuid.UUID
    requested_by: str | None
    source: str
    conversation_key: str | None
    input_message: str
    response_message: str | None
    status: str
    error_message: str | None
    agents_used: list[str]
    tools_used: list[dict]
    data_sources: list[str]
    confidence: int | None
    started_at: datetime | None
    completed_at: datetime | None
    duration_ms: int | None
    created_at: datetime
    outcome: str | None = None
    resumed_from: uuid.UUID | None = None


class AIFindingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    agent_id: uuid.UUID
    task_id: uuid.UUID | None
    host_id: uuid.UUID | None
    severity: str
    title: str
    description: str | None
    evidence: dict
    created_at: datetime
    kind: str = "fact"
    system: str | None = None
    source: str | None = None
    observed_at: datetime | None = None
    stale_after: datetime | None = None


class AIActionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    request_code: str
    agent_id: uuid.UUID
    task_id: uuid.UUID | None
    host_id: uuid.UUID | None
    action: str
    tool: str
    arguments: dict
    approval_level: int
    risk: str
    reason: str | None
    status: str
    source: str
    requested_by: str | None
    approved_by: str | None
    result: dict | None
    requested_at: datetime
    expires_at: datetime | None
    approved_at: datetime | None
    executed_at: datetime | None
