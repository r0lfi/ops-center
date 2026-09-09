"""server inventory: hosts, host_groups, credentials, host_tags, onboarding steps

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "host_groups",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "credentials",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("description", sa.Text()),
        sa.Column("credential_type", sa.String(20), nullable=False),
        sa.Column("ssh_user", sa.String(100)),
        sa.Column("secret_path", sa.String(500), nullable=False),
        sa.Column("public_key_fingerprint", sa.String(200)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "hosts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("hostname", sa.String(255), nullable=False),
        sa.Column("fqdn", sa.String(255)),
        sa.Column("ip_address", sa.String(64), nullable=False),
        sa.Column("ssh_port", sa.Integer(), nullable=False, server_default="22"),
        sa.Column("ssh_user", sa.String(100), nullable=False),
        sa.Column(
            "credential_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("credentials.id", ondelete="SET NULL"),
        ),
        sa.Column("operating_system", sa.String(100)),
        sa.Column("os_version", sa.String(100)),
        sa.Column("environment", sa.String(20), nullable=False, server_default="production"),
        sa.Column("location", sa.String(255)),
        sa.Column(
            "group_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("host_groups.id", ondelete="SET NULL"),
        ),
        sa.Column("criticality", sa.String(20), nullable=False, server_default="medium"),
        sa.Column("description", sa.Text()),
        sa.Column("auto_patch", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("security_patch_policy", sa.String(20), nullable=False, server_default="scan_only"),
        sa.Column("reboot_policy", sa.String(20), nullable=False, server_default="manual"),
        sa.Column("patch_window", sa.String(255)),
        sa.Column("monitoring_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("log_collection_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("ssh_host_fingerprint", sa.Text()),
        sa.Column("date_added", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True)),
        sa.Column("last_ansible_run", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
        ),
    )
    op.create_index("ix_hosts_hostname", "hosts", ["hostname"])
    op.create_index("ix_hosts_ip_address", "hosts", ["ip_address"])
    op.create_index("ix_hosts_environment", "hosts", ["environment"])
    op.create_index("ix_hosts_criticality", "hosts", ["criticality"])
    op.create_index("ix_hosts_group_id", "hosts", ["group_id"])

    op.create_table(
        "host_tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("tag", sa.String(100), nullable=False),
        sa.UniqueConstraint("host_id", "tag", name="uq_host_tag"),
    )
    op.create_index("ix_host_tags_host_id", "host_tags", ["host_id"])
    op.create_index("ix_host_tags_tag", "host_tags", ["tag"])

    op.create_table(
        "host_onboarding_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("step", sa.String(50), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("detail", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_host_onboarding_steps_host_id", "host_onboarding_steps", ["host_id"])


def downgrade() -> None:
    op.drop_table("host_onboarding_steps")
    op.drop_table("host_tags")
    op.drop_index("ix_hosts_group_id", table_name="hosts")
    op.drop_index("ix_hosts_criticality", table_name="hosts")
    op.drop_index("ix_hosts_environment", table_name="hosts")
    op.drop_index("ix_hosts_ip_address", table_name="hosts")
    op.drop_index("ix_hosts_hostname", table_name="hosts")
    op.drop_table("hosts")
    op.drop_table("credentials")
    op.drop_table("host_groups")
