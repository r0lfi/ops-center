import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user: str | None
    source_ip: str | None
    action: str
    target: str
    parameters: dict
    result: str
    created_at: datetime
