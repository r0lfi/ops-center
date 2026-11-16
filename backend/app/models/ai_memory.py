"""Personal memories live in the same HA database as the conversation archive."""
import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base


class AIMemory(Base):
    __tablename__ = "ai_memories"
    __table_args__ = (UniqueConstraint("user_id", "agent_id", "key", name="uq_ai_memory_user_key", postgresql_nulls_not_distinct=True),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"))
    # Free text chosen by the owner or the organizer (e.g. "Homelab Infrastructure"); NULL = uncategorized.
    category: Mapped[str | None] = mapped_column(String(80))
    # MEMORY_KINDS: a confirmed fact, a plan/intention, or historical (no longer current). NULL = fact.
    kind: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


MEMORY_KINDS = ("fact", "plan", "history")


class AIMemoryVersion(Base):
    """A note's state before it was changed, merged or deleted - so every change can be undone.
    memory_id is NULL once the note itself is gone; key/scope/content stay here to restore it."""
    __tablename__ = "ai_memory_versions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    memory_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_memories.id", ondelete="SET NULL"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[str | None] = mapped_column(String(80))
    kind: Mapped[str | None] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # What replaced this state: update, scope, merge, delete or restore; and who did it.
    change: Mapped[str] = mapped_column(String(20), nullable=False)
    changed_by: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AIMemoryPreference(Base):
    __tablename__ = "ai_memory_preferences"
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


SUGGESTION_SOURCES = ("conversation", "import", "journal")
SUGGESTION_STATUSES = ("pending", "accepted", "rejected")


class AIMemorySuggestion(Base):
    """A note an agent (nova) or an import proposes; only the owner turns it
    into a real note. One row per (user, content_hash): a rejected or accepted
    observation is never proposed again."""
    __tablename__ = "ai_memory_suggestions"
    __table_args__ = (UniqueConstraint("user_id", "content_hash", name="uq_ai_memory_suggestion_hash"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # Scope the accepted note gets; NULL = shared.
    agent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    evidence_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_tasks.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending", index=True)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when the suggestion updates an existing note instead of adding one.
    target_memory_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_memories.id", ondelete="SET NULL"))
    category: Mapped[str | None] = mapped_column(String(80))
    kind: Mapped[str | None] = mapped_column(String(20))


class AIImportedConversation(Base):
    """A conversation imported from another assistant (ChatGPT data export).
    Searchable only by the personal agent it was imported for, never synced back."""
    __tablename__ = "ai_imported_conversations"
    __table_args__ = (UniqueConstraint("user_id", "source", "external_id", name="uq_ai_imported_conversation"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    external_id: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    transcript: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    # Set once "suggest facts" has read this conversation (and again null when its content changes).
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


ORGANIZE_STATUSES = ("queued", "running", "done", "partial", "failed")


class AIMemoryOrganizeJob(Base):
    """One "Import & Organize" run: the pasted/uploaded text, split into sections the
    worker analyzes, and the proposed memories the owner reviews before saving.
    The input text is kept only until the proposals are applied or discarded."""
    __tablename__ = "ai_memory_organize_jobs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued", server_default="queued")
    source_name: Mapped[str] = mapped_column(String(200), nullable=False, default="", server_default="")
    input_text: Mapped[str | None] = mapped_column(Text)
    # [{"index": i, "chars": n, "status": "pending|done|failed", "error": str|None, "secrets": n}]
    sections: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    proposals: Mapped[list] = mapped_column(JSONB, nullable=False, default=list, server_default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
