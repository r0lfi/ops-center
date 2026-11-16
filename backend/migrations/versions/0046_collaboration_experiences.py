"""Scoped collaboration experience reuse and explicit question/answer links."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_collaboration_boards", sa.Column("scope_snapshot", JSONB(), nullable=True))
    op.add_column("ai_collaboration_posts", sa.Column("reply_to_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("fk_collaboration_post_reply", "ai_collaboration_posts", "ai_collaboration_posts", ["reply_to_id"], ["id"], ondelete="SET NULL")
    op.create_index("ix_ai_collaboration_posts_reply_to_id", "ai_collaboration_posts", ["reply_to_id"])


def downgrade():
    if op.get_bind().execute(sa.text("SELECT EXISTS (SELECT 1 FROM ai_collaboration_posts WHERE reply_to_id IS NOT NULL OR kind = 'experience')")).scalar():
        raise RuntimeError("Preserve collaboration experience scope and reply links; fix forward while these records exist.")
    op.drop_index("ix_ai_collaboration_posts_reply_to_id", table_name="ai_collaboration_posts")
    op.drop_constraint("fk_collaboration_post_reply", "ai_collaboration_posts", type_="foreignkey")
    op.drop_column("ai_collaboration_posts", "reply_to_id")
    op.drop_column("ai_collaboration_boards", "scope_snapshot")
