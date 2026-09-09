"""stacks and registries tables (Phase 2)

stacks: multi-host stack tracking - before this, stacks were ops-host-
only and purely file-derived (a directory under DOCKER_STACKS_ROOT, no DB
row). Multi-host stacks need "which host is stack X on" answerable without
asking every host.

registries: configured container registries for image pulls / update
checks. Secret material (password/token) is never stored here, same
secret_path-under-SECRETS_ROOT precedent as credentials.secret_path.

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "stacks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("hostname", sa.String(255), nullable=False),
        sa.Column("name", sa.String(63), nullable=False),
        sa.Column("source", sa.String(20), nullable=False, server_default="web_editor"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
        ),
        sa.Column("last_deployed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("hostname", "name", name="uq_stack_hostname_name"),
    )
    op.create_index("ix_stacks_hostname", "stacks", ["hostname"])

    # No filesystem-based backfill here: ops-api (where this migration runs) doesn't mount
    # DOCKER_STACKS_ROOT, only security-worker does. Existing on-disk stacks are backfilled
    # separately, once, via a small script that calls the already-working list_stacks() Celery
    # task and inserts one row per stack found - see the Phase 2 deploy notes for this migration.

    op.create_table(
        "registries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("url", sa.String(255), nullable=False),
        sa.Column("username", sa.String(255)),
        sa.Column("secret_path", sa.String(500)),
        sa.Column("auth_required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("description", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("registries")
    op.drop_index("ix_stacks_hostname", table_name="stacks")
    op.drop_table("stacks")
