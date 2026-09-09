import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

SOURCE_STATUSES = ("ok", "degraded", "error", "never_run")


class SecuritySource(Base):
    """One row per external feed. Tracks health so the UI/API can say
    'this source is currently unavailable' instead of silently going
    stale - and so a failed fetch never deletes previously-fetched data."""

    __tablename__ = "security_sources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="never_run")
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    records_last_run: Mapped[int | None] = mapped_column()


class SecurityAdvisory(Base):
    """Normalized entries from the general (not homelab-specific) advisory
    feeds - AlmaLinux errata today. Distinct from `vulnerabilities`, which
    is homelab-scoped (only CVEs actually found on a managed host/
    container); this table is the raw upstream feed."""

    __tablename__ = "security_advisories"
    __table_args__ = (UniqueConstraint("source", "advisory_id", name="uq_security_advisory_source_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    source: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    advisory_id: Mapped[str] = mapped_column(String(100), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cve_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    packages: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    url: Mapped[str | None] = mapped_column(String(500))
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
