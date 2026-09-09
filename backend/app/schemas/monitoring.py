import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MonitoringCheckRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    host_id: uuid.UUID
    check_type: str
    target: str
    enabled: bool
    created_at: datetime


class MonitoringCheckCreate(BaseModel):
    check_type: str
    target: str
    enabled: bool = True
