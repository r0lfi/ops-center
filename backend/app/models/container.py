import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

STACK_SOURCES = ("web_editor", "git", "uploaded", "app_catalog")


class Container(Base):
    """Fleet-wide container inventory - synced two different ways
    depending on the host: ops-host itself is synced directly by
    security-worker over docker.sock (the one component with socket
    access - see docs/security.md); every other managed host is synced
    over the same SSH connection already used for patching/monitoring, via
    ansible/playbooks/container-inventory.yml + worker.tasks._store_container_inventory
    - never a second docker.sock exposure. `hostname` distinguishes which
    host a given container is on, since names are only unique per-host."""

    __tablename__ = "containers"
    __table_args__ = (UniqueConstraint("hostname", "name", name="uq_container_hostname_name"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    hostname: Mapped[str] = mapped_column(String(255), nullable=False, server_default="ops-host")
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    image: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="unknown")
    health: Mapped[str | None] = mapped_column(String(30))
    restart_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Stack(Base):
    """A deployed docker-compose stack. Unlike Container, this row is the
    source of truth for "which host is this on" - before this table
    existed, stacks were ops-host-only and purely file-derived (a
    directory under DOCKER_STACKS_ROOT with no DB row at all). Multi-host
    stacks need that answerable without asking every host. Container
    membership/status is still fetched live (docker compose ps), not
    stored here - same "live fetch, no sync job" choice Phase 1 made for
    Images/Networks/Volumes."""

    __tablename__ = "stacks"
    __table_args__ = (UniqueConstraint("hostname", "name", name="uq_stack_hostname_name"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    hostname: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(63), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="web_editor")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    last_deployed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Registry(Base):
    """A configured container registry (Docker Hub, GHCR, a private
    registry, etc). Secret material is never stored here or returned to
    the frontend - secret_path is a filename under SECRETS_ROOT, same
    precedent as Credential.secret_path (see backend/app/models/host.py)."""

    __tablename__ = "registries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    url: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str | None] = mapped_column(String(255))
    secret_path: Mapped[str | None] = mapped_column(String(500))
    auth_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DockerEvent(Base):
    """Docker daemon/container events. Only ever populated for ops-host
    (a continuous background thread in security-worker - see
    security/events.py - reads `docker events` and writes here); remote
    hosts have no persistent channel to stream from (same constraint Logs/
    Stats hit in Phase 1), so their Events tab gets a bounded one-shot
    window per request instead and never touches this table."""

    __tablename__ = "docker_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    hostname: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)  # container|image|network|volume|daemon
    # Usually short (start|die|restart|pull|create|...), but Docker embeds
    # the full command in exec_create/exec_start actions (e.g. a health
    # check's "exec_start: /bin/sh -c curl ... || exit 1"), which can run
    # well past a normal action name - 255 leaves headroom, and
    # security/events.py truncates defensively before insert regardless.
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(128))
    actor_attributes: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
