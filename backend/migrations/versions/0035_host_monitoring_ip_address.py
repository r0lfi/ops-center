"""hosts.monitoring_ip_address

Revision ID: 0035
Revises: 0034
Create Date: 2026-09-08

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: Union[str, None] = "0034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("hosts", sa.Column("monitoring_ip_address", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "monitoring_ip_address")
