"""docker hosts flag + generic ansible query result payload

Adds hosts.is_docker_host (gates the new Docker Hosts UI - backfilled true
for any host that already has synced container rows, plus ops-host
itself) and ansible_jobs.result_payload (generic JSON passthrough for
one-shot "ask a remote host something" playbooks like docker-images.yml,
via worker/tasks.py's new QUERY_MARKER - see that file).

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "hosts", sa.Column("is_docker_host", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.create_index("ix_hosts_is_docker_host", "hosts", ["is_docker_host"])
    op.execute(
        "UPDATE hosts SET is_docker_host = true "
        "WHERE hostname = 'ops-host' OR hostname IN (SELECT DISTINCT hostname FROM containers)"
    )

    op.add_column("ansible_jobs", sa.Column("result_payload", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("ansible_jobs", "result_payload")
    op.drop_index("ix_hosts_is_docker_host", table_name="hosts")
    op.drop_column("hosts", "is_docker_host")
