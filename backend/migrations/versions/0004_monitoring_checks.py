"""monitoring_checks, hosts.reboot_required

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.add_column("hosts", sa.Column("reboot_required", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "monitoring_checks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("check_type", sa.String(30), nullable=False),
        sa.Column("target", sa.String(500), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_monitoring_checks_host_id", "monitoring_checks", ["host_id"])


def downgrade() -> None:
    op.drop_table("monitoring_checks")
    op.drop_column("hosts", "reboot_required")
