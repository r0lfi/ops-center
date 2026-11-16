"""Administrator-set weekly AI budget limit.

One row (id 1). Without it the built-in default of $20 applies, so existing
installations keep their limit until an administrator changes it.

Revision ID: 0065
Revises: 0064
Create Date: 2026-11-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_budget_settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("limit_usd", sa.Numeric(10, 2), nullable=False),
        sa.Column("updated_by", sa.String(100)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.CheckConstraint("id = 1", name="ck_ai_budget_settings_single_row"),
        sa.CheckConstraint("limit_usd >= 1 AND limit_usd <= 1000", name="ck_ai_budget_settings_limit"),
    )


def downgrade() -> None:
    op.drop_table("ai_budget_settings")
