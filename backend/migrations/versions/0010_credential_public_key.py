"""credentials.public_key

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("credentials", sa.Column("public_key", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("credentials", "public_key")
