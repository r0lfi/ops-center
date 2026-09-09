"""patch_scans, patches

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "patch_scans",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("ansible_job_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ansible_jobs.id")),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("pending_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pending_security_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reboot_required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_patch_scans_host_id", "patch_scans", ["host_id"])

    op.create_table(
        "patches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "patch_scan_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("patch_scans.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("package_name", sa.String(255), nullable=False),
        sa.Column("installed_version", sa.String(255)),
        sa.Column("fixed_version", sa.String(255)),
        sa.Column("is_security", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("severity", sa.String(20), nullable=False, server_default="unknown"),
        sa.Column("advisory_id", sa.String(100)),
        sa.Column("cve_ids", postgresql.ARRAY(sa.String()), nullable=False, server_default="{}"),
        sa.Column("repository", sa.String(255)),
        sa.Column("extra", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_patches_patch_scan_id", "patches", ["patch_scan_id"])
    op.create_index("ix_patches_host_id", "patches", ["host_id"])


def downgrade() -> None:
    op.drop_table("patches")
    op.drop_index("ix_patch_scans_host_id", table_name="patch_scans")
    op.drop_table("patch_scans")
