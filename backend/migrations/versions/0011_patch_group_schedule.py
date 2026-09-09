"""host_groups patch scheduling columns

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # NULL cron_expression = an ordinary (non-scheduled) group, unchanged
    # from before this migration. Setting cron_expression + schedule_enabled
    # is what turns a group into an auto-patch schedule.
    op.add_column("host_groups", sa.Column("cron_expression", sa.String(100), nullable=True))
    op.add_column("host_groups", sa.Column("patch_type", sa.String(20), nullable=True))
    op.add_column(
        "host_groups", sa.Column("batch_size", sa.Integer(), nullable=False, server_default="1")
    )
    op.add_column(
        "host_groups",
        sa.Column("schedule_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("host_groups", sa.Column("last_triggered_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("host_groups", "last_triggered_at")
    op.drop_column("host_groups", "schedule_enabled")
    op.drop_column("host_groups", "batch_size")
    op.drop_column("host_groups", "patch_type")
    op.drop_column("host_groups", "cron_expression")
