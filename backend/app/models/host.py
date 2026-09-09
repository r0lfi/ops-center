import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

# Free-text fields, validated by the Pydantic layer rather than DB enums,
# so adding a new value never requires a migration.
ENVIRONMENTS = ("production", "test", "development")
CRITICALITIES = ("low", "medium", "high", "critical")
SECURITY_PATCH_POLICIES = ("disabled", "scan_only", "auto")
REBOOT_POLICIES = ("manual", "automatic")
CREDENTIAL_TYPES = ("ssh_key", "ssh_password")
GROUP_PATCH_TYPES = ("security", "all", "pihole")
# One playbook per patch_type - the single source of truth both
# backend/app/api/routes/host_groups.py (manual "run now") and
# worker/scheduled_tasks.py (cron-triggered) dispatch through, so the two
# never drift out of sync with each other or with GROUP_PATCH_TYPES above.
GROUP_PATCH_PLAYBOOKS = {
    "security": "patch-security.yml",
    "all": "patch-all.yml",
    "pihole": "pihole-update.yml",
}
ONBOARDING_STEPS = (
    "verify_network",
    "verify_ssh",
    "record_fingerprint",
    "gather_facts",
    "detect_os",
    "deploy_monitoring",
    "baseline_patch_scan",
    "baseline_vuln_scan",
    "prometheus_sd",
)
ONBOARDING_STATUSES = ("pending", "running", "ok", "failed", "blocked")

# A host can belong to any number of groups at once (e.g. an "OS patching"
# group and a separate "pihole gravity update" group on their own
# independent schedules) - see migration 0015, which replaced the earlier
# single hosts.group_id column with this join table.
host_group_members = Table(
    "host_group_members",
    Base.metadata,
    Column("host_id", UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), primary_key=True),
    Column("group_id", UUID(as_uuid=True), ForeignKey("host_groups.id", ondelete="CASCADE"), primary_key=True),
)


class HostGroup(Base):
    __tablename__ = "host_groups"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Auto-patch scheduling (optional - a group with cron_expression NULL is
    # an ordinary categorization group, same as before this existed). When
    # set, worker.scheduled_tasks.run_scheduled_patch_groups checks it every
    # minute against the group's cron expression (interpreted in
    # configured timezone, not UTC - see that task) and, on a match, submits a
    # patch-security.yml/patch-all.yml job for every host currently in the
    # group. This is the one place in the whole app where patching actually
    # runs without an explicit per-run human action - everywhere else,
    # "actual patch installation is never automatic" (see
    # worker/scheduled_tasks.py's nightly_patch_scan). schedule_enabled
    # lets a schedule be paused without losing its configuration.
    cron_expression: Mapped[str | None] = mapped_column(String(100))
    patch_type: Mapped[str | None] = mapped_column(String(20))
    batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    hosts: Mapped[list["Host"]] = relationship(secondary=host_group_members, back_populates="groups")


class Credential(Base):
    __tablename__ = "credentials"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    credential_type: Mapped[str] = mapped_column(String(20), nullable=False)
    ssh_user: Mapped[str | None] = mapped_column(String(100))
    # Path relative to the secrets root (/data/ops-center/secrets). The
    # secret material itself is never stored in the database - see docs/security.md.
    secret_path: Mapped[str] = mapped_column(String(500), nullable=False)
    # The public half of an ssh_key credential - safe to store/display/copy
    # over the API, unlike the private key (which never touches the API in
    # either direction - see docs/security.md). Used so an admin can copy
    # it into a target server's ~/.ssh/authorized_keys after generating a
    # keypair with scripts/credentials/generate-ssh-key.sh.
    public_key: Mapped[str | None] = mapped_column(Text)
    public_key_fingerprint: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    hosts: Mapped[list["Host"]] = relationship(back_populates="credential")


class Host(Base):
    __tablename__ = "hosts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    hostname: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    fqdn: Mapped[str | None] = mapped_column(String(255))
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Overrides ip_address as the Prometheus node_exporter scrape target
    # (see prometheus_sd.py) when set - lets a host's monitoring path
    # diverge from its SSH/Ansible management path, e.g. edge-host is
    # managed over its public IP but scraped over a WireGuard tunnel.
    monitoring_ip_address: Mapped[str | None] = mapped_column(String(64))
    ssh_port: Mapped[int] = mapped_column(Integer, nullable=False, default=22)
    ssh_user: Mapped[str] = mapped_column(String(100), nullable=False)

    credential_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("credentials.id", ondelete="SET NULL")
    )
    credential: Mapped[Credential | None] = relationship(back_populates="hosts")

    operating_system: Mapped[str | None] = mapped_column(String(100))
    os_version: Mapped[str | None] = mapped_column(String(100))
    environment: Mapped[str] = mapped_column(String(20), nullable=False, default="production", index=True)
    location: Mapped[str | None] = mapped_column(String(255))
    # Manually entered, not GeoIP-derived - most of this fleet is on
    # private LAN ranges with no meaningful public geolocation anyway, and
    # a self-hosted app has no business calling out to a third-party GeoIP
    # API. Currently only meaningful for edge-host (the one host with a
    # public IP) - its Traffic Map destination pin reads this directly
    # (app.services.traffic_watch.start_traffic_watch).
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)

    groups: Mapped[list[HostGroup]] = relationship(secondary=host_group_members, back_populates="hosts")

    criticality: Mapped[str] = mapped_column(String(20), nullable=False, default="medium", index=True)
    description: Mapped[str | None] = mapped_column(Text)

    auto_patch: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    security_patch_policy: Mapped[str] = mapped_column(String(20), nullable=False, default="scan_only")
    reboot_policy: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    patch_window: Mapped[str | None] = mapped_column(String(255))

    monitoring_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    log_collection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Gates whether this host shows up in the Docker Hosts UI (Containers ->
    # Docker Hosts). Doesn't change how the host is otherwise managed - a
    # plain flag, not a new host type.
    is_docker_host: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)

    ssh_host_fingerprint: Mapped[str | None] = mapped_column(Text)
    reboot_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    date_added: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_ansible_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tags: Mapped[list["HostTag"]] = relationship(back_populates="host", cascade="all, delete-orphan")
    onboarding_steps: Mapped[list["HostOnboardingStep"]] = relationship(
        back_populates="host", cascade="all, delete-orphan", order_by="HostOnboardingStep.created_at"
    )


class HostTag(Base):
    __tablename__ = "host_tags"
    __table_args__ = (UniqueConstraint("host_id", "tag", name="uq_host_tag"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    tag: Mapped[str] = mapped_column(String(100), nullable=False)

    host: Mapped[Host] = relationship(back_populates="tags")


class HostOnboardingStep(Base):
    __tablename__ = "host_onboarding_steps"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    detail: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    host: Mapped[Host] = relationship(back_populates="onboarding_steps")
