import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AutomationRunRequest(BaseModel):
    playbook: str
    target_type: str  # "host" | "hosts" | "group"
    host_id: uuid.UUID | None = None
    host_ids: list[uuid.UUID] | None = None
    group_id: uuid.UUID | None = None
    limit: str | None = Field(default=None, max_length=500)
    batch_size: int | None = Field(default=None, ge=1, le=1000)
    services: list[str] | None = None
    required_services: list[str] | None = None


class AnsibleEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    sequence: int
    event_type: str
    host: str | None
    task: str | None
    message: str | None
    created_at: datetime


class AnsibleJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user: str | None
    playbook: str
    target_description: str
    limit: str | None
    extra_vars: dict
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    changed_hosts: int
    successful_hosts: int
    failed_hosts: int
    unreachable_hosts: int
    created_at: datetime
    events: list[AnsibleEventRead] = Field(default_factory=list)
