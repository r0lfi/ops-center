"""Persistent MCP authorization, approvals and metadata-only audit records."""

import uuid
from datetime import datetime
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class MCPSettings(Base):
    __tablename__ = "mcp_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    revision: Mapped[int] = mapped_column(Integer, default=1)


class MCPClient(Base):
    __tablename__ = "mcp_clients"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    redirect_uris: Mapped[list] = mapped_column(JSONB, default=list)
    scopes: Mapped[list] = mapped_column(JSONB, default=list)
    allowed_tools: Mapped[list] = mapped_column(JSONB, default=list)
    allowed_user_ids: Mapped[list] = mapped_column(JSONB, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MCPGrant(Base):
    __tablename__ = "mcp_grants"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_id: Mapped[str] = mapped_column(
        ForeignKey("mcp_clients.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    scopes: Mapped[list] = mapped_column(JSONB, default=list)
    allowed_tools: Mapped[list] = mapped_column(JSONB, default=list)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_agents.id", ondelete="CASCADE")
    )
    resource: Mapped[str] = mapped_column(String(500))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MCPAuthorization(Base):
    __tablename__ = "mcp_authorizations"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    client_id: Mapped[str] = mapped_column(
        ForeignKey("mcp_clients.id", ondelete="CASCADE")
    )
    parameters: Mapped[dict] = mapped_column(JSONB)
    grant_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mcp_grants.id", ondelete="CASCADE")
    )
    code_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MCPToken(Base):
    __tablename__ = "mcp_tokens"
    digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    grant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_grants.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_tasks.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(10))
    scopes: Mapped[list] = mapped_column(JSONB, default=list)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MCPRequest(Base):
    __tablename__ = "mcp_requests"
    __table_args__ = (UniqueConstraint("grant_id", "idempotency_key"),)
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    grant_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_grants.id", ondelete="CASCADE"), index=True
    )
    token_scopes: Mapped[list] = mapped_column(JSONB, default=list)
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("ai_tasks.id", ondelete="SET NULL")
    )
    tool: Mapped[str] = mapped_column(String(160))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    argument_digest: Mapped[str] = mapped_column(String(64))
    encrypted_arguments: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    result: Mapped[dict | None] = mapped_column(JSONB)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class MCPAudit(Base):
    __tablename__ = "mcp_audit"
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    user_id: Mapped[str | None] = mapped_column(String(36))
    client_id: Mapped[str | None] = mapped_column(String(128))
    grant_id: Mapped[str | None] = mapped_column(String(36))
    agent_id: Mapped[str | None] = mapped_column(String(36))
    task_id: Mapped[str | None] = mapped_column(String(36))
    operation: Mapped[str] = mapped_column(String(160))
    outcome: Mapped[str] = mapped_column(String(32))
    argument_digest: Mapped[str | None] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(36))
