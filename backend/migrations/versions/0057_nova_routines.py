"""Proactive nova: routines, their runs and the owner's proactive settings.

- nova_routines: owner, name, cron schedule, instruction, channel (web/talk), enabled.
- nova_routine_runs: one row per routine and due time (unique), so a due
  routine runs once even with two schedulers or a redelivered tick.
- nova_proactive_settings: per owner on/off (off by default), quiet hours
  and a daily cap on proactive messages.

Downgrade refuses while routines or runs exist, because dropping them would
lose the owner's routines and their history.

Revision ID: 0057
Revises: 0056
Create Date: 2026-10-25
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0057"
down_revision = "0056"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "nova_routines",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("schedule", sa.String(100), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("channel", sa.String(10), nullable=False, server_default="web"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("channel IN ('web', 'talk')", name="ck_nova_routines_channel"),
    )
    op.create_index("ix_nova_routines_user_id", "nova_routines", ["user_id"])
    op.create_table(
        "nova_routine_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("routine_id", UUID(as_uuid=True), sa.ForeignKey("nova_routines.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("manual", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("channel", sa.String(10), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("reason", sa.String(200), nullable=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivery_error", sa.String(200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("routine_id", "due_at", name="uq_nova_routine_runs_due"),
    )
    op.create_index("ix_nova_routine_runs_user_created", "nova_routine_runs", ["user_id", "created_at"])
    op.create_index("ix_nova_routine_runs_task_id", "nova_routine_runs", ["task_id"])
    op.create_table(
        "nova_proactive_settings",
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("quiet_start", sa.Time(), nullable=False, server_default="22:00"),
        sa.Column("quiet_end", sa.Time(), nullable=False, server_default="07:00"),
        sa.Column("max_per_day", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade():
    in_use = op.get_bind().execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM nova_routines) OR EXISTS (SELECT 1 FROM nova_routine_runs)"
    )).scalar()
    if in_use:
        raise RuntimeError("Cannot downgrade: nova routines or their runs exist and would be lost.")
    op.drop_table("nova_proactive_settings")
    op.drop_index("ix_nova_routine_runs_task_id", table_name="nova_routine_runs")
    op.drop_index("ix_nova_routine_runs_user_created", table_name="nova_routine_runs")
    op.drop_table("nova_routine_runs")
    op.drop_index("ix_nova_routines_user_id", table_name="nova_routines")
    op.drop_table("nova_routines")
