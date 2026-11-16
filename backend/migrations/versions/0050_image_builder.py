"""Air-Gap Image Builder: projects, immutable builds, blobs, presets/templates."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0050"
down_revision = "0049"
branch_labels = None
depends_on = None

J = sa.text("'{}'::jsonb")
L = sa.text("'[]'::jsonb")


def upgrade():
    op.create_table(
        "builder_projects",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(63), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("repository", sa.String(200), nullable=False),
        sa.Column("image_type", sa.String(16), nullable=False, server_default="distrobox"),
        sa.Column("mode", sa.String(16), nullable=False, server_default="gui"),
        sa.Column("spec", JSONB(), nullable=False, server_default=J),
        sa.Column("custom_containerfile", sa.Text()),
        sa.Column("next_version", sa.String(32), nullable=False, server_default="1.0.0"),
        sa.Column("base_digest", sa.String(80)),
        sa.Column("base_prepared_at", sa.DateTime(timezone=True)),
        sa.Column("base_upstream_digest", sa.String(80)),
        sa.Column("base_checked_at", sa.DateTime(timezone=True)),
        sa.Column("base_error", sa.Text()),
        sa.Column("base_log", sa.Text(), nullable=False, server_default=""),
        sa.Column("base_status", sa.String(16), nullable=False, server_default="missing"),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_builder_projects_name", "builder_projects", ["name"])
    op.create_index("uq_builder_projects_live_name", "builder_projects", ["name"], unique=True,
                    postgresql_where=sa.text("deleted_at IS NULL"))
    op.execute("CREATE SEQUENCE builder_build_number_seq START 1")
    op.create_table(
        "builder_builds",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("number", sa.Integer(), nullable=False, unique=True,
                  server_default=sa.text("nextval('builder_build_number_seq')")),
        sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("builder_projects.id"), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("reason", sa.String(32), nullable=False, server_default="build"),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text()),
        sa.Column("log", sa.Text(), nullable=False, server_default=""),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("containerfile", sa.Text(), nullable=False),
        sa.Column("spec", JSONB(), nullable=False, server_default=J),
        sa.Column("base_image", sa.String(500)),
        sa.Column("base_digest", sa.String(80)),
        sa.Column("architecture", sa.String(16), nullable=False, server_default="amd64"),
        sa.Column("packages", JSONB(), nullable=False, server_default=L),
        sa.Column("files", JSONB(), nullable=False, server_default=L),
        sa.Column("build_args", JSONB(), nullable=False, server_default=J),
        sa.Column("no_cache", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("tags", JSONB(), nullable=False, server_default=L),
        sa.Column("image_ref", sa.String(300)),
        sa.Column("image_id", sa.String(80)),
        sa.Column("image_digest", sa.String(80)),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("inspect", JSONB(), nullable=False, server_default=J),
        sa.Column("tests", JSONB(), nullable=False, server_default=L),
        sa.Column("tested_at", sa.DateTime(timezone=True)),
        sa.Column("artifact_id", UUID(as_uuid=True), sa.ForeignKey("airgap_artifacts.id")),
        sa.Column("manifest", JSONB(), nullable=False, server_default=J),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_builder_builds_project_id", "builder_builds", ["project_id"])
    op.create_index("ix_builder_builds_status", "builder_builds", ["status"])
    # A version is built once; a failed attempt may be retried.
    op.create_index("uq_builder_builds_version", "builder_builds", ["project_id", "version"], unique=True,
                    postgresql_where=sa.text("status <> 'failed'"))
    op.create_table(
        "builder_blobs",
        sa.Column("sha256", sa.String(64), primary_key=True),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("source", sa.String(1000), nullable=False),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "builder_presets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("data", JSONB(), nullable=False, server_default=J),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("uq_builder_presets_kind_name", "builder_presets", ["kind", "name"], unique=True)


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM builder_builds)")).scalar():
        raise RuntimeError("Image Builder builds exist; they are the reproducibility record. Fix forward.")
    op.drop_table("builder_presets")
    op.drop_table("builder_blobs")
    op.drop_table("builder_builds")
    op.execute("DROP SEQUENCE builder_build_number_seq")
    op.drop_table("builder_projects")
