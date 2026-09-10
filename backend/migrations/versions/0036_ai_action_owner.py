"""Add the action ownership column already declared by the application model.

Revision ID: 0036
Revises: 0035
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "ai_actions",
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_ai_actions_owner_user_id", "ai_actions", "users",
        ["owner_user_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index("ix_ai_actions_owner_user_id", "ai_actions", ["owner_user_id"])


def downgrade():
    op.drop_index("ix_ai_actions_owner_user_id", table_name="ai_actions")
    op.drop_constraint("fk_ai_actions_owner_user_id", "ai_actions", type_="foreignkey")
    op.drop_column("ai_actions", "owner_user_id")
