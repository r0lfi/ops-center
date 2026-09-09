"""hosts.latitude/longitude

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("hosts", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("hosts", sa.Column("longitude", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("hosts", "longitude")
    op.drop_column("hosts", "latitude")
