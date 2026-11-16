"""Memory suggestions: notes nova or an import proposes for the owner to review.

Additive: one new table. Downgrade refuses while suggestions exist, because
rejected hashes are what keep a dismissed observation from coming back.

Revision ID: 0054
Revises: 0053
Create Date: 2026-10-25
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ai_memory_suggestions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source", sa.String(20), nullable=False),
        sa.Column("evidence_task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "content_hash", name="uq_ai_memory_suggestion_hash"),
    )
    op.create_index("ix_ai_memory_suggestions_status", "ai_memory_suggestions", ["status"])


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM ai_memory_suggestions)")).scalar():
        raise RuntimeError("Cannot downgrade while memory suggestions exist; rejected suggestions would come back.")
    op.drop_index("ix_ai_memory_suggestions_status", table_name="ai_memory_suggestions")
    op.drop_table("ai_memory_suggestions")
