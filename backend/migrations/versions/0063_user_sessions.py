"""Server-side browser sessions with rotating refresh tokens.

user_sessions holds one row per signed-in browser. The refresh token lives
only in an HttpOnly cookie; the table stores its SHA-256. Logging out,
an administrator revoking a session, deactivating a user or changing their
password sets revoked_at, which every API request checks through the
access token's session id.

Existing bearer tokens carry no session id and stop working: every browser
signs in once after this upgrade.

Revision ID: 0063
Revises: 0062
Create Date: 2026-11-14
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_sessions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("previous_token_hash", sa.String(64)),
        sa.Column("rotated_at", sa.DateTime(timezone=True)),
        sa.Column("remember", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("idle_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_reason", sa.String(40)),
        sa.Column("revoked_by", sa.String(100)),
        sa.Column("user_agent", sa.String(300)),
        sa.Column("ip", sa.String(45)),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_previous_token_hash", "user_sessions", ["previous_token_hash"])


def downgrade() -> None:
    op.drop_table("user_sessions")
