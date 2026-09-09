"""vulnerabilities, host_vulnerabilities, container_vulnerabilities

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "vulnerabilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("cve_id", sa.String(50), nullable=False),
        sa.Column("package_name", sa.String(255), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False, server_default="unknown"),
        sa.Column("cvss_score", sa.Float()),
        sa.Column("fixed_version", sa.String(255)),
        sa.Column("source", sa.String(50), nullable=False, server_default="trivy"),
        sa.Column("description", sa.Text()),
        sa.Column("references", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("cisa_kev", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("epss_score", sa.Float()),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("cve_id", "package_name", name="uq_vulnerability_cve_package"),
    )
    op.create_index("ix_vulnerabilities_cve_id", "vulnerabilities", ["cve_id"])
    op.create_index("ix_vulnerabilities_severity", "vulnerabilities", ["severity"])
    op.create_index("ix_vulnerabilities_cisa_kev", "vulnerabilities", ["cisa_kev"])

    op.create_table(
        "host_vulnerabilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "vulnerability_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("vulnerabilities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("installed_version", sa.String(255)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("host_id", "vulnerability_id", name="uq_host_vulnerability"),
    )
    op.create_index("ix_host_vulnerabilities_host_id", "host_vulnerabilities", ["host_id"])
    op.create_index("ix_host_vulnerabilities_vulnerability_id", "host_vulnerabilities", ["vulnerability_id"])

    op.create_table(
        "container_vulnerabilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("container_name", sa.String(255), nullable=False),
        sa.Column("image", sa.String(500), nullable=False),
        sa.Column(
            "vulnerability_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("vulnerabilities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("installed_version", sa.String(255)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("container_name", "vulnerability_id", name="uq_container_vulnerability"),
    )
    op.create_index("ix_container_vulnerabilities_container_name", "container_vulnerabilities", ["container_name"])
    op.create_index("ix_container_vulnerabilities_vulnerability_id", "container_vulnerabilities", ["vulnerability_id"])


def downgrade() -> None:
    op.drop_table("container_vulnerabilities")
    op.drop_table("host_vulnerabilities")
    op.drop_table("vulnerabilities")
