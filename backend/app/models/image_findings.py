import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SecretFinding(Base):
    """One row per (container, detector, file, redacted-value) found by
    trufflehog walking image layers - including files a later `RUN rm`
    only whiteout-marked, not actually removed. Never stores the raw
    secret (trufflehog's `Raw` field) - only the `Redacted` preview it
    already produces itself, same as this project never persists
    credential material anywhere else (see docs/security.md)."""

    __tablename__ = "secret_findings"
    __table_args__ = (
        UniqueConstraint("container_name", "detector_name", "file_path", "redacted", name="uq_secret_finding"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    container_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    image: Mapped[str] = mapped_column(String(500), nullable=False)
    detector_name: Mapped[str] = mapped_column(String(100), nullable=False)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    redacted: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str | None] = mapped_column(String(1000))
    layer_digest: Mapped[str | None] = mapped_column(String(100))
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ImageLintFinding(Base):
    """One row per (container, dockle code) - dockle's CIS-Docker-Benchmark
    image config checks (root user, missing HEALTHCHECK, etc). Kept
    separate from Vulnerability: these are config-shape findings, not
    CVEs, so they don't fit the CVE+package granularity that table is
    built around."""

    __tablename__ = "image_lint_findings"
    __table_args__ = (UniqueConstraint("container_name", "code", name="uq_image_lint_finding"),)

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    container_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    image: Mapped[str] = mapped_column(String(500), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    level: Mapped[str] = mapped_column(String(20), nullable=False, default="INFO", index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    alerts: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
