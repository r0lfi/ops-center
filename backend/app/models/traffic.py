"""Durable traffic observations and transactional collector checkpoints."""

from sqlalchemy import BigInteger, Boolean, Float, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class TrafficEntry(Base):
    __tablename__ = "traffic_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_key: Mapped[str] = mapped_column(String(64), unique=True)
    ts: Mapped[float] = mapped_column(Float)
    ip: Mapped[str] = mapped_column(String(45))
    lat: Mapped[float | None] = mapped_column(Float)
    lon: Mapped[float | None] = mapped_column(Float)
    city: Mapped[str | None] = mapped_column(String(160))
    country: Mapped[str | None] = mapped_column(String(160))
    domain: Mapped[str] = mapped_column(String(253))
    status: Mapped[int | None] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(24))
    signal: Mapped[str | None] = mapped_column(String(24))
    suspicious: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (
        Index("ix_traffic_events_ts", "ts"),
        Index("ix_traffic_events_source_ts", "source", "ts"),
        Index("ix_traffic_events_signal_ts", "signal", "ts"),
        Index("ix_traffic_events_origin", "domain", "ip", "id"),
        Index("ix_traffic_events_domain_ts", "domain", "ts"),
        Index("ix_traffic_events_kind_ts", "kind", "ts"),
    )


class TrafficCollector(Base):
    __tablename__ = "traffic_collectors"
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    checkpoint: Mapped[dict] = mapped_column(JSONB, default=dict)
    last_success: Mapped[float | None] = mapped_column(Float)
    last_error: Mapped[str | None] = mapped_column(String(120))


class TrafficSecurityAlert(Base):
    __tablename__ = "traffic_security_alerts"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    source: Mapped[str | None] = mapped_column(String(32))
    rule: Mapped[str] = mapped_column(String(40))
    severity: Mapped[str] = mapped_column(String(16))
    domain: Mapped[str] = mapped_column(String(253))
    ip: Mapped[str] = mapped_column(String(45))
    count: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[float] = mapped_column(Float)
    last_seen: Mapped[float] = mapped_column(Float)
    evidence: Mapped[dict] = mapped_column(JSONB)
    reviewed_at: Mapped[float | None] = mapped_column(Float)
    reviewed_by: Mapped[str | None] = mapped_column(String(100))
    notified_at: Mapped[float | None] = mapped_column(Float)
    __table_args__ = (
        Index("ix_traffic_security_alerts_created", "created_at"),
        Index("ix_traffic_security_alerts_source", "source"),
        Index("ix_traffic_security_alerts_group", "rule", "domain", "ip", "created_at"),
    )


class TrafficSettings(Base):
    __tablename__ = "traffic_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
