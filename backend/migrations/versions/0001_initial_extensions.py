"""initial extensions

Revision ID: 0001
Revises:
Create Date: 2026-08-27

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # gen_random_uuid() for UUID primary keys used by domain tables added in later phases
    op.execute('CREATE EXTENSION IF NOT EXISTS pgcrypto')


def downgrade() -> None:
    op.execute('DROP EXTENSION IF EXISTS pgcrypto')
