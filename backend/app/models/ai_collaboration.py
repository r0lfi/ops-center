"""Persistent, task-owned collaboration and conservative token accounting."""
import uuid
from datetime import date, datetime
from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class AICollaborationSettings(Base):
    __tablename__ = "ai_collaboration_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    policy: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)


class AICollaborationBoard(Base):
    __tablename__ = "ai_collaboration_boards"
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="CASCADE"), primary_key=True)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    policy: Mapped[dict] = mapped_column(JSONB, nullable=False)
    participants: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    requests: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="running")
    stop_reason: Mapped[str | None] = mapped_column(Text)
    charged_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    actual_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    model_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AICollaborationPost(Base):
    __tablename__ = "ai_collaboration_posts"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_collaboration_boards.task_id", ondelete="CASCADE"), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    agent: Mapped[str] = mapped_column(String(50), nullable=False)
    recipient: Mapped[str | None] = mapped_column(String(50))
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AICollaborationDailyUsage(Base):
    __tablename__ = "ai_collaboration_daily_usage"
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    charged_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AICollaborationReservation(Base):
    __tablename__ = "ai_collaboration_reservations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_collaboration_boards.task_id", ondelete="CASCADE"), nullable=False, index=True)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    input_estimate: Mapped[int] = mapped_column(Integer, nullable=False)
    charged_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="reserved")
