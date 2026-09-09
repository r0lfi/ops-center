"""widen docker_events.action (Phase 2b follow-up)

Docker embeds the full command in exec_create/exec_start actions (e.g. a
health check's "exec_start: /bin/sh -c curl ... || exit 1"), which
overflowed the original varchar(50) within minutes of the listener going
live - see security/events.py's defensive truncation added alongside this.

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("docker_events", "action", type_=sa.String(255), existing_type=sa.String(50))


def downgrade() -> None:
    op.alter_column("docker_events", "action", type_=sa.String(50), existing_type=sa.String(255))
