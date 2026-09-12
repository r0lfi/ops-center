"""Task-owned collaboration boards and budgets. Revision 0037, revises 0036."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID
revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("ai_collaboration_settings", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("revision", sa.Integer(), nullable=False), sa.Column("policy", JSONB(), nullable=False))
    op.execute("INSERT INTO ai_collaboration_settings (id, revision, policy) VALUES (1, 1, '{}')")
    op.create_table("ai_collaboration_boards",
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("owner_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        *[sa.Column(n, JSONB(), nullable=False) for n in ("policy", "participants", "requests")],
        sa.Column("status", sa.String(30), nullable=False), sa.Column("stop_reason", sa.Text()),
        *[sa.Column(n, sa.Integer(), nullable=False) for n in ("charged_tokens", "actual_tokens", "model_calls", "message_count")],
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_ai_collaboration_boards_owner_user_id", "ai_collaboration_boards", ["owner_user_id"])
    op.create_table("ai_collaboration_posts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_collaboration_boards.task_id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("agent", sa.String(50), nullable=False),
        sa.Column("recipient", sa.String(50)), sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_ai_collaboration_posts_task_id", "ai_collaboration_posts", ["task_id"])
    op.create_table("ai_collaboration_daily_usage", sa.Column("day", sa.Date(), primary_key=True), sa.Column("charged_tokens", sa.Integer(), nullable=False))
    op.create_table("ai_collaboration_reservations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_collaboration_boards.task_id", ondelete="CASCADE"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False), sa.Column("input_estimate", sa.Integer(), nullable=False),
        sa.Column("charged_tokens", sa.Integer(), nullable=False), sa.Column("status", sa.String(20), nullable=False))
    op.create_index("ix_ai_collaboration_reservations_task_id", "ai_collaboration_reservations", ["task_id"])

def downgrade():
    for name in ("reservations", "daily_usage", "posts", "boards", "settings"):
        op.drop_table("ai_collaboration_" + name)
