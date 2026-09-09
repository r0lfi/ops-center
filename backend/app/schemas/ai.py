import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.ai import AI_PROVIDER_KINDS


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
    last_activity_at: datetime | None
    updated_at: datetime


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
    max_tool_calls: int = 8
    max_execution_seconds: int = 90
    enabled: bool = True


class AIAgentUpdate(BaseModel):
    description: str | None = None
    provider_id: uuid.UUID | None = None
    model: str | None = None
    system_prompt: str | None = None
    allowed_tools: list[str] | None = None
    allowed_hosts: list[str] | None = None
    allowed_environments: list[str] | None = None
    autonomy_level: int | None = None
    max_tool_calls: int | None = None
    max_execution_seconds: int | None = None
    enabled: bool | None = None


class AskRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    agent: str = "coordinator"
    # Groups this and future asks into one remembered conversation - see
    # app.models.ai.AITask.conversation_key. Omitted means what it always
    # meant: a standalone question with no history.
    conversation_key: str | None = Field(default=None, max_length=200)


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
