"""secret_findings, image_lint_findings (trufflehog + dockle)

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "secret_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("container_name", sa.String(255), nullable=False),
        sa.Column("image", sa.String(500), nullable=False),
        sa.Column("detector_name", sa.String(100), nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("redacted", sa.String(255), nullable=False),
        sa.Column("file_path", sa.String(1000)),
        sa.Column("layer_digest", sa.String(100)),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("container_name", "detector_name", "file_path", "redacted", name="uq_secret_finding"),
    )
    op.create_index("ix_secret_findings_container_name", "secret_findings", ["container_name"])
    op.create_index("ix_secret_findings_verified", "secret_findings", ["verified"])

    op.create_table(
        "image_lint_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("container_name", sa.String(255), nullable=False),
        sa.Column("image", sa.String(500), nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("level", sa.String(20), nullable=False, server_default="INFO"),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("alerts", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("container_name", "code", name="uq_image_lint_finding"),
    )
    op.create_index("ix_image_lint_findings_container_name", "image_lint_findings", ["container_name"])
    op.create_index("ix_image_lint_findings_code", "image_lint_findings", ["code"])
    op.create_index("ix_image_lint_findings_level", "image_lint_findings", ["level"])


def downgrade() -> None:
    op.drop_table("image_lint_findings")
    op.drop_table("secret_findings")
