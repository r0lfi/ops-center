"""Organized memory: categories, kinds, version history and Import & Organize jobs.

- ai_memories.category (free text) and ai_memories.kind (fact/plan/history);
  existing notes keep NULL, i.e. uncategorized facts.
- ai_memory_versions: the state before every change, merge or delete.
- ai_memory_suggestions.target_memory_id/category/kind: a suggestion can
  update an existing note.
- ai_memory_organize_jobs: analysis runs the owner reviews before saving.

Downgrade refuses while any of the new data exists, because dropping it would
lose categories, undo history or unsaved proposals.

Revision ID: 0056
Revises: 0055
Create Date: 2026-10-25
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0056"
down_revision = "0055"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_memories", sa.Column("category", sa.String(80), nullable=True))
    op.add_column("ai_memories", sa.Column("kind", sa.String(20), nullable=True))
    op.create_table(
        "ai_memory_versions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("memory_id", UUID(as_uuid=True), sa.ForeignKey("ai_memories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("category", sa.String(80), nullable=True),
        sa.Column("kind", sa.String(20), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("change", sa.String(20), nullable=False),
        sa.Column("changed_by", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ai_memory_versions_memory_id", "ai_memory_versions", ["memory_id"])
    op.create_index("ix_ai_memory_versions_user_id", "ai_memory_versions", ["user_id"])
    op.add_column("ai_memory_suggestions", sa.Column("target_memory_id", UUID(as_uuid=True),
                                                     sa.ForeignKey("ai_memories.id", ondelete="SET NULL"), nullable=True))
    op.add_column("ai_memory_suggestions", sa.Column("category", sa.String(80), nullable=True))
    op.add_column("ai_memory_suggestions", sa.Column("kind", sa.String(20), nullable=True))
    op.create_table(
        "ai_memory_organize_jobs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("source_name", sa.String(200), nullable=False, server_default=""),
        sa.Column("input_text", sa.Text(), nullable=True),
        sa.Column("sections", JSONB, nullable=False, server_default="[]"),
        sa.Column("proposals", JSONB, nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_ai_memory_organize_jobs_user_id", "ai_memory_organize_jobs", ["user_id"])


def downgrade():
    in_use = op.get_bind().execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM ai_memory_versions) OR EXISTS (SELECT 1 FROM ai_memory_organize_jobs)"
        " OR EXISTS (SELECT 1 FROM ai_memories WHERE category IS NOT NULL OR kind IS NOT NULL)"
        " OR EXISTS (SELECT 1 FROM ai_memory_suggestions WHERE target_memory_id IS NOT NULL OR category IS NOT NULL OR kind IS NOT NULL)"
    )).scalar()
    if in_use:
        raise RuntimeError("Cannot downgrade: categories, memory history or organize jobs exist and would be lost.")
    op.drop_index("ix_ai_memory_organize_jobs_user_id", table_name="ai_memory_organize_jobs")
    op.drop_table("ai_memory_organize_jobs")
    op.drop_column("ai_memory_suggestions", "kind")
    op.drop_column("ai_memory_suggestions", "category")
    op.drop_column("ai_memory_suggestions", "target_memory_id")
    op.drop_index("ix_ai_memory_versions_user_id", table_name="ai_memory_versions")
    op.drop_index("ix_ai_memory_versions_memory_id", table_name="ai_memory_versions")
    op.drop_table("ai_memory_versions")
    op.drop_column("ai_memories", "kind")
    op.drop_column("ai_memories", "category")
