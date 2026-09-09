import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PatchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    host_id: uuid.UUID
    package_name: str
    installed_version: str | None
    fixed_version: str | None
    is_security: bool
    severity: str
    advisory_id: str | None
    cve_ids: list[str]
    repository: str | None


class PatchScanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    host_id: uuid.UUID
    status: str
    pending_count: int
    pending_security_count: int
    reboot_required: bool
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    patches: list[PatchRead] = []
