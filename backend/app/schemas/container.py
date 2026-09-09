import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ContainerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    hostname: str
    name: str
    image: str
    status: str
    health: str | None
    restart_count: int
    last_seen: datetime
    vulnerability_count: int = 0
    critical_vulnerability_count: int = 0


class ContainerActionResult(BaseModel):
    ok: bool
    message: str


class StackDeployRequest(BaseModel):
    name: str = Field(min_length=1, max_length=63, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    compose_yaml: str = Field(min_length=1)


class StackActionResult(BaseModel):
    ok: bool
    stdout: str
    stderr: str


class StackRead(BaseModel):
    name: str
    compose_yaml: str
    # Host-absolute path to the compose file on disk, for operators who
    # want to find/inspect it outside Ops Center too. None only if the
    # host couldn't be reached to resolve it.
    path: str | None = None


class StackSummaryRead(BaseModel):
    id: uuid.UUID
    hostname: str
    name: str
    source: str
    container_count: int = 0
    running_count: int = 0
    created_at: datetime
    updated_at: datetime
    last_deployed_at: datetime | None = None
    # False for a docker-compose project discovered on the host (Portainer,
    # or deployed by hand) that was never deployed through Ops Center -
    # see backend/app/services/stack_discovery.py. Such rows are never
    # persisted to the stacks table - they're a live-fetch overlay on top
    # of it, same "no sync job" treatment Images/Networks/Volumes already
    # get, recomputed on every GET /docker-hosts/{hostname}/stacks.
    managed: bool = True


class StackContainerRead(BaseModel):
    id: str
    name: str
    image: str
    status: str
    health: str | None = None


class ImageUpdateStatusRead(BaseModel):
    status: str  # "up_to_date" | "update_available" | "unknown"
    local_digest: str | None = None
    latest_digest: str | None = None
    detail: str | None = None


class ImageRead(BaseModel):
    id: str
    repo_tags: list[str] = Field(default_factory=list)
    repo_digests: list[str] = Field(default_factory=list)
    created: str | None = None
    size_bytes: int = 0
    container_count: int = 0


class NetworkContainerRead(BaseModel):
    name: str
    ipv4_address: str | None = None
    ipv6_address: str | None = None
    mac_address: str | None = None


class NetworkRead(BaseModel):
    id: str
    name: str
    driver: str
    scope: str
    subnet: str | None = None
    gateway: str | None = None
    containers: list[NetworkContainerRead] = Field(default_factory=list)


class VolumeRead(BaseModel):
    name: str
    driver: str
    mountpoint: str
    created: str | None = None


class ContainerStatsRead(BaseModel):
    """Field names/format (e.g. "12.5MiB / 256MiB") match `docker stats`'s
    own display strings verbatim - both the local and remote paths run that
    exact command (see security/docker_control.py's container_stats and
    ansible/playbooks/docker-stats.yml), so there's one shape either way and
    no unit-conversion logic to get wrong on either side."""

    cpu_percent: str | None = None
    mem_usage: str | None = None
    mem_percent: str | None = None
    net_io: str | None = None
    block_io: str | None = None
    pids: str | None = None


class ContainerLogsRead(BaseModel):
    lines: list[str]
    ok: bool = True


class BulkActionRequest(BaseModel):
    names: list[str] = Field(min_length=1, max_length=100)
    action: str


class BulkActionItemResult(BaseModel):
    name: str
    ok: bool
    message: str


class BulkActionResponse(BaseModel):
    results: list[BulkActionItemResult]


class DockerEventRead(BaseModel):
    hostname: str
    event_type: str
    action: str
    actor_id: str | None = None
    actor_attributes: dict = Field(default_factory=dict)
    occurred_at: datetime


class DockerHostRead(BaseModel):
    hostname: str
    ip_address: str
    environment: str
    container_count: int = 0
    running_count: int = 0
    stopped_count: int = 0
    unhealthy_count: int = 0
    last_seen: datetime | None = None
