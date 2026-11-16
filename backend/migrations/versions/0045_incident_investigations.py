"""Owned, idempotent automatic IM investigation tasks."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("im_investigations",
        sa.Column("incident_id", sa.BigInteger(), sa.ForeignKey("im_incidents.id"), primary_key=True),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id"), unique=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True))


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM im_investigations)")).scalar():
        raise RuntimeError("Preserve IM ownership and deduplication history; do not downgrade with investigations.")
    op.drop_table("im_investigations")
