"""AI token usage table; write/RPC tools for Containers, Security, Network; web tools for General

- ai_usage: one row per provider round trip (see app.models.ai.AIUsage),
  feeding the AI Provider Usage panel that was an honest empty state until
  now because nothing captured tokens.
- Containers Agent gains container_action (start/stop/restart, always
  approval-gated) and get_container_logs; Security Agent gains scan_host
  (vulnerability-scan.yml, approval-gated); Network Agent gains
  list_docker_networks. All go through the same local security-worker RPC /
  remote Ansible split the Containers page already uses.
- General Agent gains read-only web_fetch/web_search and higher tool-call
  and time budgets for longer investigations.

Revision ID: 0027
Revises: 0026
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027"
down_revision: Union[str, None] = "0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ADDED_TOOLS = {
    "container": ["container_action", "get_container_logs"],
    "security": ["scan_host"],
    "network": ["list_docker_networks"],
    "general": ["web_fetch", "web_search"],
}


def upgrade() -> None:
    op.create_table(
        "ai_usage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")),
        sa.Column(
            "agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("provider_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_providers.id", ondelete="SET NULL")),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ai_usage_task_id", "ai_usage", ["task_id"])
    op.create_index("ix_ai_usage_agent_id", "ai_usage", ["agent_id"])
    op.create_index("ix_ai_usage_provider_id", "ai_usage", ["provider_id"])
    op.create_index("ix_ai_usage_created_at", "ai_usage", ["created_at"])

    for slug, tools in _ADDED_TOOLS.items():
        for tool in tools:
            # jsonb append, skipping tools already present (idempotent).
            # CAST(), not ::text - SQLAlchemy's text() doesn't see ":tool::text"
            # as a bind parameter because of the colons that follow it.
            op.execute(
                sa.text(
                    "UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST(:tool AS text)) "
                    "WHERE slug = :slug AND NOT allowed_tools @> to_jsonb(ARRAY[CAST(:tool AS text)])"
                ).bindparams(tool=tool, slug=slug)
            )

    op.execute(
        "UPDATE ai_agents SET max_tool_calls = 40, max_execution_seconds = 900 WHERE slug = 'general'"
    )


def downgrade() -> None:
    for slug, tools in _ADDED_TOOLS.items():
        for tool in tools:
            op.execute(
                sa.text("UPDATE ai_agents SET allowed_tools = allowed_tools - CAST(:tool AS text) WHERE slug = :slug").bindparams(
                    tool=tool, slug=slug
                )
            )
    op.execute("UPDATE ai_agents SET max_tool_calls = 20, max_execution_seconds = 300 WHERE slug = 'general'")
    op.drop_table("ai_usage")
