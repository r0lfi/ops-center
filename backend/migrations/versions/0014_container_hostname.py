"""containers.hostname, per-host uniqueness

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing rows are all ops-host (the only host containers.py ever
    # synced before this) - the server_default backfills them for free.
    op.add_column(
        "containers", sa.Column("hostname", sa.String(255), nullable=False, server_default="ops-host")
    )
    op.drop_constraint("containers_name_key", "containers", type_="unique")
    op.create_unique_constraint("uq_container_hostname_name", "containers", ["hostname", "name"])


def downgrade() -> None:
    op.drop_constraint("uq_container_hostname_name", "containers", type_="unique")
    op.create_unique_constraint("containers_name_key", "containers", ["name"])
    op.drop_column("containers", "hostname")
