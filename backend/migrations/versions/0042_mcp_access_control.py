"""MCP access grants, one-use credentials and human approval requests."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "mcp_settings",
        sa.Column("id", sa.Integer(), nullable=False, primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, primary_key=False),
        sa.Column("revision", sa.Integer(), nullable=False, primary_key=False),
    )
    op.create_table(
        "mcp_clients",
        sa.Column("id", sa.String(128), nullable=False, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, primary_key=False),
        sa.Column(
            "redirect_uris", postgresql.JSONB(), nullable=False, primary_key=False
        ),
        sa.Column("scopes", postgresql.JSONB(), nullable=False, primary_key=False),
        sa.Column(
            "allowed_tools", postgresql.JSONB(), nullable=False, primary_key=False
        ),
        sa.Column(
            "allowed_user_ids", postgresql.JSONB(), nullable=False, primary_key=False
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, primary_key=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            primary_key=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_table(
        "mcp_grants",
        sa.Column(
            "id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=True
        ),
        sa.Column("client_id", sa.String(128), nullable=False, primary_key=False),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=False
        ),
        sa.Column("scopes", postgresql.JSONB(), nullable=False, primary_key=False),
        sa.Column(
            "allowed_tools", postgresql.JSONB(), nullable=False, primary_key=False
        ),
        sa.Column(
            "agent_id", postgresql.UUID(as_uuid=True), nullable=True, primary_key=False
        ),
        sa.Column("resource", sa.String(500), nullable=False, primary_key=False),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False, primary_key=False
        ),
        sa.Column(
            "revoked_at", sa.DateTime(timezone=True), nullable=True, primary_key=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            primary_key=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["client_id"], ["mcp_clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["agent_id"], ["ai_agents.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_mcp_grants_user_id", "mcp_grants", ["user_id"], unique=False)
    op.create_index(
        "ix_mcp_grants_client_id", "mcp_grants", ["client_id"], unique=False
    )
    op.create_table(
        "mcp_authorizations",
        sa.Column("id", sa.String(128), nullable=False, primary_key=True),
        sa.Column("client_id", sa.String(128), nullable=False, primary_key=False),
        sa.Column("parameters", postgresql.JSONB(), nullable=False, primary_key=False),
        sa.Column(
            "grant_id", postgresql.UUID(as_uuid=True), nullable=True, primary_key=False
        ),
        sa.Column("code_hash", sa.String(64), nullable=True, primary_key=False),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False, primary_key=False
        ),
        sa.Column(
            "consumed_at", sa.DateTime(timezone=True), nullable=True, primary_key=False
        ),
        sa.ForeignKeyConstraint(["grant_id"], ["mcp_grants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["client_id"], ["mcp_clients.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("code_hash"),
    )
    op.create_table(
        "mcp_tokens",
        sa.Column("digest", sa.String(64), nullable=False, primary_key=True),
        sa.Column(
            "grant_id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=False
        ),
        sa.Column(
            "task_id", postgresql.UUID(as_uuid=True), nullable=True, primary_key=False
        ),
        sa.Column("kind", sa.String(10), nullable=False, primary_key=False),
        sa.Column("scopes", postgresql.JSONB(), nullable=False, primary_key=False),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False, primary_key=False
        ),
        sa.Column(
            "consumed_at", sa.DateTime(timezone=True), nullable=True, primary_key=False
        ),
        sa.ForeignKeyConstraint(["grant_id"], ["mcp_grants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_id"], ["ai_tasks.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_mcp_tokens_grant_id", "mcp_tokens", ["grant_id"], unique=False)
    op.create_table(
        "mcp_requests",
        sa.Column(
            "id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=True
        ),
        sa.Column(
            "grant_id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=False
        ),
        sa.Column(
            "token_scopes", postgresql.JSONB(), nullable=False, primary_key=False
        ),
        sa.Column(
            "task_id", postgresql.UUID(as_uuid=True), nullable=True, primary_key=False
        ),
        sa.Column("tool", sa.String(160), nullable=False, primary_key=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False, primary_key=False),
        sa.Column("argument_digest", sa.String(64), nullable=False, primary_key=False),
        sa.Column("encrypted_arguments", sa.Text(), nullable=True, primary_key=False),
        sa.Column("status", sa.String(24), nullable=False, primary_key=False),
        sa.Column("result", postgresql.JSONB(), nullable=True, primary_key=False),
        sa.Column(
            "decided_by",
            postgresql.UUID(as_uuid=True),
            nullable=True,
            primary_key=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            primary_key=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=False, primary_key=False
        ),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["grant_id"], ["mcp_grants.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("grant_id", "idempotency_key"),
        sa.ForeignKeyConstraint(["task_id"], ["ai_tasks.id"], ondelete="SET NULL"),
    )
    op.create_index(
        "ix_mcp_requests_grant_id", "mcp_requests", ["grant_id"], unique=False
    )
    op.create_table(
        "mcp_audit",
        sa.Column(
            "id", postgresql.UUID(as_uuid=True), nullable=False, primary_key=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            primary_key=False,
            server_default=sa.func.now(),
        ),
        sa.Column("user_id", sa.String(36), nullable=True, primary_key=False),
        sa.Column("client_id", sa.String(128), nullable=True, primary_key=False),
        sa.Column("grant_id", sa.String(36), nullable=True, primary_key=False),
        sa.Column("agent_id", sa.String(36), nullable=True, primary_key=False),
        sa.Column("task_id", sa.String(36), nullable=True, primary_key=False),
        sa.Column("operation", sa.String(160), nullable=False, primary_key=False),
        sa.Column("outcome", sa.String(32), nullable=False, primary_key=False),
        sa.Column("argument_digest", sa.String(64), nullable=True, primary_key=False),
        sa.Column("request_id", sa.String(36), nullable=True, primary_key=False),
    )
    op.create_index(
        "ix_mcp_audit_created_at", "mcp_audit", ["created_at"], unique=False
    )
    op.execute("INSERT INTO mcp_settings (id, enabled, revision) VALUES (1, false, 1)")


def downgrade():
    op.drop_table("mcp_audit")
    op.drop_table("mcp_requests")
    op.drop_table("mcp_tokens")
    op.drop_table("mcp_authorizations")
    op.drop_table("mcp_grants")
    op.drop_table("mcp_clients")
    op.drop_table("mcp_settings")
