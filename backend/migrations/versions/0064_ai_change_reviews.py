"""Review and release record for developer-agent changes.

ai_change_reviews is append-only: who approved, requested changes or
rejected a developer patch (bound to the patch's SHA-256), and who recorded
its release, failed release or rollback. New proposal statuses:
changes_requested, approved (for production), release_failed, rolled_back.
Only the API writes this table, from routes that need a signed-in admin
browser session with a recently confirmed password. Rows cannot be updated.

Revision ID: 0064
Revises: 0063
Create Date: 2026-11-14
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_change_reviews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("proposal_id", UUID(as_uuid=True), sa.ForeignKey("ai_tool_proposals.id", ondelete="CASCADE"), nullable=False),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("patch_sha256", sa.String(64)),
        sa.Column("comment", sa.Text),
        sa.Column("release_ref", sa.String(200)),
        sa.Column("decided_by", sa.String(100), nullable=False),
        sa.Column("decided_by_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("decision IN ('approve','request_changes','reject','released','release_failed','rolled_back')",
                           name="ck_ai_change_reviews_decision"),
    )
    op.create_index("ix_ai_change_reviews_proposal_id", "ai_change_reviews", ["proposal_id"])
    # Append-only: a decision cannot be edited afterwards, not even through SQL.
    op.execute("""
        CREATE FUNCTION ai_change_reviews_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'ai_change_reviews is append-only'; END $$;
        CREATE TRIGGER ai_change_reviews_no_update BEFORE UPDATE ON ai_change_reviews
            FOR EACH ROW EXECUTE FUNCTION ai_change_reviews_append_only();
    """)


def downgrade() -> None:
    op.drop_table("ai_change_reviews")
    op.execute("DROP FUNCTION IF EXISTS ai_change_reviews_append_only()")
