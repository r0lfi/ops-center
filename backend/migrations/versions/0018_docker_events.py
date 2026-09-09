"""docker_events table (Phase 2b)

Only ever populated for ops-host (a background thread in security-worker
streams `docker events` into it - see security/events.py). Remote hosts get
a bounded one-shot window per request instead, never write here.

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "docker_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("hostname", sa.String(255), nullable=False),
        sa.Column("event_type", sa.String(30), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("actor_id", sa.String(128)),
        sa.Column("actor_attributes", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_docker_events_hostname_occurred_at", "docker_events", ["hostname", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_docker_events_hostname_occurred_at", table_name="docker_events")
    op.drop_table("docker_events")
