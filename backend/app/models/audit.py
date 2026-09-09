import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AuditLogEntry(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user: Mapped[str | None] = mapped_column(String(100))
    source_ip: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(10), nullable=False)  # HTTP method
    target: Mapped[str] = mapped_column(String(500), nullable=False)  # request path
    parameters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    result: Mapped[str] = mapped_column(String(20), nullable=False)  # HTTP status class, e.g. "200", "403"
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
