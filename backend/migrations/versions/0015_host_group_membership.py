"""host group membership: many-to-many instead of hosts.group_id

A host could only ever belong to one group, so e.g. an "OS patching" group
and a separate "pihole gravity update" group (different schedules, partly
overlapping membership) couldn't both apply to the same host - adding it to
one silently dropped it from the other. Replaces hosts.group_id with a
host_group_members join table; existing single memberships are preserved.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "host_group_members",
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"),
            nullable=False, primary_key=True,
        ),
        sa.Column(
            "group_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("host_groups.id", ondelete="CASCADE"),
            nullable=False, primary_key=True,
        ),
    )
    op.create_index("ix_host_group_members_group_id", "host_group_members", ["group_id"])

    # Preserve every host's current single membership as its first row here.
    op.execute(
        "INSERT INTO host_group_members (host_id, group_id) "
        "SELECT id, group_id FROM hosts WHERE group_id IS NOT NULL"
    )

    op.drop_constraint("hosts_group_id_fkey", "hosts", type_="foreignkey")
    op.drop_index("ix_hosts_group_id", table_name="hosts")
    op.drop_column("hosts", "group_id")


def downgrade() -> None:
    op.add_column("hosts", sa.Column("group_id", postgresql.UUID(as_uuid=True)))
    op.create_index("ix_hosts_group_id", "hosts", ["group_id"])
    op.create_foreign_key(
        "hosts_group_id_fkey", "hosts", "host_groups", ["group_id"], ["id"], ondelete="SET NULL"
    )

    # Best-effort: a host in multiple groups can't be represented by a
    # single column, so this arbitrarily keeps one (lowest group_id).
    op.execute(
        "UPDATE hosts SET group_id = sub.group_id FROM ("
        "  SELECT DISTINCT ON (host_id) host_id, group_id FROM host_group_members "
        "  ORDER BY host_id, group_id"
        ") sub WHERE hosts.id = sub.host_id"
    )

    op.drop_table("host_group_members")
