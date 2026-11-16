"""Preserve runtime identity and allowlisted monitoring metadata."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("containers", sa.Column("runtime_id", sa.String(64), nullable=True))
    op.create_index("ix_containers_runtime_id", "containers", ["runtime_id"])
    op.add_column("containers", sa.Column("monitoring_metadata", JSONB, nullable=True))
    op.add_column("hosts", sa.Column("container_inventory_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    op.drop_column("hosts", "container_inventory_at")
    op.drop_column("containers", "monitoring_metadata")
    op.drop_index("ix_containers_runtime_id", table_name="containers")
    op.drop_column("containers", "runtime_id")
