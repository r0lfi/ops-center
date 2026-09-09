import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

PATCH_SCAN_STATUSES = ("queued", "running", "completed", "failed")
PATCH_SEVERITIES = ("critical", "important", "moderate", "low", "unknown")


class PatchScan(Base):
    __tablename__ = "patch_scans"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ansible_job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ansible_jobs.id"))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued")
    pending_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pending_security_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reboot_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    patches: Mapped[list["Patch"]] = relationship(back_populates="scan", cascade="all, delete-orphan")


class Patch(Base):
    __tablename__ = "patches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    patch_scan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("patch_scans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    package_name: Mapped[str] = mapped_column(String(255), nullable=False)
    installed_version: Mapped[str | None] = mapped_column(String(255))
    fixed_version: Mapped[str | None] = mapped_column(String(255))
    is_security: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    advisory_id: Mapped[str | None] = mapped_column(String(100))
    cve_ids: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    repository: Mapped[str | None] = mapped_column(String(255))
    extra: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    scan: Mapped[PatchScan] = relationship(back_populates="patches")
