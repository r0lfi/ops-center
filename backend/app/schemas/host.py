import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.host import CRITICALITIES, ENVIRONMENTS, REBOOT_POLICIES, SECURITY_PATCH_POLICIES


class OnboardingStepRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    step: str
    status: str
    detail: str | None
    started_at: datetime | None
    finished_at: datetime | None


class HostGroupMemberRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    hostname: str


class HostGroupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    cron_expression: str | None
    patch_type: str | None
    batch_size: int
    schedule_enabled: bool
    last_triggered_at: datetime | None
    hosts: list[HostGroupMemberRead] = Field(default_factory=list)


class HostGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    cron_expression: str | None = None
    patch_type: str | None = None
    batch_size: int | None = Field(default=None, ge=1, le=1000)
    schedule_enabled: bool | None = None


class CredentialRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    credential_type: str
    ssh_user: str | None
    public_key: str | None
    public_key_fingerprint: str | None


class CredentialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    credential_type: str
    ssh_user: str | None = None
    # Filename of a secret already placed under /data/ops-center/secrets/credentials
    # by the operator. Raw key material is never accepted over the API.
    secret_filename: str = Field(min_length=1, max_length=255)
    # Public half of an ssh_key credential - safe over the API. Typically
    # pasted in after running scripts/credentials/generate-ssh-key.sh, which
    # prints it. Never the private key.
    public_key: str | None = None


class HostCreate(BaseModel):
    hostname: str = Field(min_length=1, max_length=255)
    fqdn: str | None = None
    ip_address: str = Field(min_length=1, max_length=64)
    monitoring_ip_address: str | None = Field(default=None, max_length=64)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(min_length=1, max_length=100)
    credential_id: uuid.UUID | None = None
    environment: str = "production"
    location: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    criticality: str = "medium"
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    services_to_monitor: list[str] = Field(default_factory=list)
    auto_patch: bool = False
    security_patch_policy: str = "scan_only"
    reboot_policy: str = "manual"
    patch_window: str | None = None
    monitoring_enabled: bool = True
    log_collection_enabled: bool = True
    is_docker_host: bool = False

    def validate_choices(self) -> None:
        if self.environment not in ENVIRONMENTS:
            raise ValueError(f"environment must be one of {ENVIRONMENTS}")
        if self.criticality not in CRITICALITIES:
            raise ValueError(f"criticality must be one of {CRITICALITIES}")
        if self.security_patch_policy not in SECURITY_PATCH_POLICIES:
            raise ValueError(f"security_patch_policy must be one of {SECURITY_PATCH_POLICIES}")
        if self.reboot_policy not in REBOOT_POLICIES:
            raise ValueError(f"reboot_policy must be one of {REBOOT_POLICIES}")


class HostUpdate(BaseModel):
    hostname: str | None = None
    fqdn: str | None = None
    ip_address: str | None = None
    monitoring_ip_address: str | None = None
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_user: str | None = None
    credential_id: uuid.UUID | None = None
    environment: str | None = None
    location: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    # None = leave group memberships untouched; [] = remove from every
    # group; a list = set membership to exactly those groups. Same
    # "unset vs empty vs value" convention as tags below.
    group_ids: list[uuid.UUID] | None = None
    criticality: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    auto_patch: bool | None = None
    security_patch_policy: str | None = None
    reboot_policy: str | None = None
    patch_window: str | None = None
    monitoring_enabled: bool | None = None
    log_collection_enabled: bool | None = None
    is_docker_host: bool | None = None


class HostRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    hostname: str
    fqdn: str | None
    ip_address: str
    monitoring_ip_address: str | None
    ssh_port: int
    ssh_user: str
    credential_id: uuid.UUID | None
    operating_system: str | None
    os_version: str | None
    environment: str
    location: str | None
    latitude: float | None
    longitude: float | None
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    criticality: str
    description: str | None
    auto_patch: bool
    security_patch_policy: str
    reboot_policy: str
    patch_window: str | None
    monitoring_enabled: bool
    log_collection_enabled: bool
    is_docker_host: bool
    ssh_host_fingerprint: str | None
    reboot_required: bool
    date_added: datetime
    last_seen: datetime | None
    last_ansible_run: datetime | None
    tags: list[str] = Field(default_factory=list)
    onboarding_steps: list[OnboardingStepRead] = Field(default_factory=list)

    @classmethod
    def from_orm_host(cls, host) -> "HostRead":
        data = {
            c: getattr(host, c)
            for c in cls.model_fields
            if c not in ("tags", "onboarding_steps", "group_ids")
        }
        data["tags"] = [t.tag for t in host.tags]
        data["onboarding_steps"] = list(host.onboarding_steps)
        data["group_ids"] = [g.id for g in host.groups]
        return cls.model_validate(data)
