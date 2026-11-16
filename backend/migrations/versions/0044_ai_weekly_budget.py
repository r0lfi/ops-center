"""Global weekly USD cap and durable provider reservations."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("ai_budget_weeks",
        sa.Column("week_start", sa.Date(), primary_key=True),
        sa.Column("initialized", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("billed_usd", sa.Numeric(18, 8), nullable=False, server_default="0"),
        sa.Column("reserved_usd", sa.Numeric(18, 8), nullable=False, server_default="0"),
        sa.Column("unpriced_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("warning_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("billed_usd >= 0 AND reserved_usd >= 0 AND unpriced_calls >= 0", name="ck_ai_budget_nonnegative"))
    op.create_table("ai_budget_reservations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("week_start", sa.Date(), sa.ForeignKey("ai_budget_weeks.week_start"), nullable=False),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="SET NULL")),
        sa.Column("provider_kind", sa.String(20), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("input_bound", sa.Integer(), nullable=False),
        sa.Column("output_cap", sa.Integer(), nullable=False),
        sa.Column("input_rate", sa.Numeric(18, 8), nullable=False),
        sa.Column("output_rate", sa.Numeric(18, 8), nullable=False),
        sa.Column("reserved_usd", sa.Numeric(18, 8), nullable=False),
        sa.Column("billed_usd", sa.Numeric(18, 8)),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("actual_input_tokens", sa.Integer()),
        sa.Column("actual_output_tokens", sa.Integer()),
        sa.Column("cache_read_tokens", sa.Integer()),
        sa.Column("cache_write_tokens", sa.Integer()),
        sa.Column("cache_write_1h_tokens", sa.Integer()),
        sa.Column("settled_at", sa.DateTime(timezone=True)))
    op.create_index("ix_ai_budget_reservations_week_start", "ai_budget_reservations", ["week_start"])
    op.create_index("ix_ai_budget_reservations_task_id", "ai_budget_reservations", ["task_id"])


def downgrade():
    op.drop_table("ai_budget_reservations")
    op.drop_table("ai_budget_weeks")
