"""Personal agent memory, stored locally and scoped to the authenticated user.

Revision ID: 0033
Revises: 0032
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_tasks", sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_ai_tasks_owner_user_id", "ai_tasks", ["owner_user_id"])
    # Preserve existing users' history, but never attach older history to a reused username.
    op.execute("UPDATE ai_tasks t SET owner_user_id = u.id FROM users u WHERE t.source = 'web' AND t.requested_by = u.username AND t.created_at >= u.created_at")
    op.create_table("ai_memories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "key", name="uq_ai_memory_user_key"),
    )
    op.create_index("ix_ai_memories_user_id", "ai_memories", ["user_id"])
    op.create_table("ai_memory_preferences",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade():
    op.drop_table("ai_memory_preferences")
    op.drop_index("ix_ai_memories_user_id", table_name="ai_memories")
    op.drop_table("ai_memories")
    op.drop_index("ix_ai_tasks_owner_user_id", table_name="ai_tasks")
    op.drop_column("ai_tasks", "owner_user_id")
