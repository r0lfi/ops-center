import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RegistryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    url: str
    username: str | None
    auth_required: bool
    description: str | None
    created_at: datetime


class RegistryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=255)
    username: str | None = None
    # Filename of a secret (password/token) already placed under
    # /data/ops-center/secrets/registries by the operator - same pattern as
    # CredentialCreate.secret_filename. Raw secret material is never
    # accepted over the API.
    secret_filename: str | None = None
    auth_required: bool = True
    description: str | None = None
