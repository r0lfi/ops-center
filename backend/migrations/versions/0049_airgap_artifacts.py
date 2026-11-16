"""Air-gap Distrobox and OCI image artifacts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "airgap_artifacts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("distribution", sa.String(64)),
        sa.Column("version", sa.String(128)),
        sa.Column("source", sa.String(500)),
        sa.Column("registry", sa.String(255)),
        sa.Column("repository", sa.String(255)),
        sa.Column("tag", sa.String(128)),
        sa.Column("digest", sa.String(80)),
        sa.Column("platform_digest", sa.String(80)),
        sa.Column("image_id", sa.String(80)),
        sa.Column("architecture", sa.String(32)),
        sa.Column("image_created", sa.String(64)),
        sa.Column("filename", sa.String(255)),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("sha256", sa.String(64)),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text()),
        sa.Column("log", sa.Text(), nullable=False, server_default=""),
        sa.Column("details", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("upstream_digest", sa.String(80)),
        sa.Column("upstream_checked_at", sa.DateTime(timezone=True)),
        sa.Column("upstream_error", sa.Text()),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("deleted_by", sa.String(100)),
    )
    op.create_index("ix_airgap_artifacts_kind", "airgap_artifacts", ["kind"])
    op.create_index("ix_airgap_artifacts_status", "airgap_artifacts", ["status"])
    op.create_index("ix_airgap_artifacts_source", "airgap_artifacts", ["source"])
    # Two live artifacts never share a file name, so nothing is overwritten.
    op.create_index(
        "uq_airgap_artifacts_filename", "airgap_artifacts", ["filename"], unique=True,
        postgresql_where=sa.text("filename IS NOT NULL AND deleted_at IS NULL"),
    )


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM airgap_artifacts)")).scalar():
        raise RuntimeError("Air-gap artifact records exist; delete them in Ops Center before downgrading.")
    op.drop_table("airgap_artifacts")
