import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

CHECK_TYPES = ("systemd_unit", "blackbox_icmp", "blackbox_tcp", "blackbox_http", "blackbox_https", "blackbox_dns")


class MonitoringCheck(Base):
    __tablename__ = "monitoring_checks"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    check_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # systemd_unit: unit name (e.g. "sshd.service"). blackbox_*: host:port or URL.
    target: Mapped[str] = mapped_column(String(500), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    host = relationship("Host")
