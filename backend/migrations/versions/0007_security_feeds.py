"""security_sources, security_advisories

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "security_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("name", sa.String(50), nullable=False, unique=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="never_run"),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True)),
        sa.Column("last_success_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.Text()),
        sa.Column("records_last_run", sa.Integer()),
    )

    op.create_table(
        "security_advisories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("source", sa.String(50), nullable=False),
        sa.Column("advisory_id", sa.String(100), nullable=False),
        sa.Column("title", sa.Text()),
        sa.Column("severity", sa.String(20), nullable=False, server_default="unknown"),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("cve_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("packages", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("url", sa.String(500)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("source", "advisory_id", name="uq_security_advisory_source_id"),
    )
    op.create_index("ix_security_advisories_source", "security_advisories", ["source"])


def downgrade() -> None:
    op.drop_table("security_advisories")
    op.drop_table("security_sources")
