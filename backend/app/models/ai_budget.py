"""Global USD admission ledger; pending and uncertain requests remain reserved."""
import uuid
from datetime import date, datetime
from decimal import Decimal
from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class AIBudgetWeek(Base):
    __tablename__ = "ai_budget_weeks"
    week_start: Mapped[date] = mapped_column(Date, primary_key=True)
    initialized: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    billed_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, default=0)
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, default=0)
    unpriced_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    warning_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AIBudgetSettings(Base):
    """One row (id 1): the weekly limit an administrator chose. Missing row = the defaults."""
    __tablename__ = "ai_budget_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    limit_usd: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(100))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AIBudgetReservation(Base):
    __tablename__ = "ai_budget_reservations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    week_start: Mapped[date] = mapped_column(Date, ForeignKey("ai_budget_weeks.week_start"), nullable=False, index=True)
    task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"), index=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="SET NULL"))
    provider_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    input_bound: Mapped[int] = mapped_column(Integer, nullable=False)
    output_cap: Mapped[int] = mapped_column(Integer, nullable=False)
    input_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    output_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    billed_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actual_input_tokens: Mapped[int | None] = mapped_column(Integer)
    actual_output_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_write_1h_tokens: Mapped[int | None] = mapped_column(Integer)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
