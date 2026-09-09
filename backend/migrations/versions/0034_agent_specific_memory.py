"""Shared and agent-specific personal notes.

Revision ID: 0034
Revises: 0033
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade():
    # NULL means shared. Existing notes retain their contents and shared scope.
    op.add_column("ai_memories", sa.Column("agent_id", postgresql.UUID(as_uuid=True),
        sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True))
    op.drop_constraint("uq_ai_memory_user_key", "ai_memories", type_="unique")
    op.create_unique_constraint("uq_ai_memory_user_key", "ai_memories", ["user_id", "agent_id", "key"],
        postgresql_nulls_not_distinct=True)


def downgrade():
    # Never flatten specialist notes into shared notes or discard their scope.
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT EXISTS (SELECT 1 FROM ai_memories WHERE agent_id IS NOT NULL)")).scalar():
        raise RuntimeError("Cannot downgrade while agent-specific notes exist; preserve/export them first.")
    op.drop_constraint("uq_ai_memory_user_key", "ai_memories", type_="unique")
    op.drop_column("ai_memories", "agent_id")
    op.create_unique_constraint("uq_ai_memory_user_key", "ai_memories", ["user_id", "key"])
