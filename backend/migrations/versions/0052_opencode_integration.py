"""External agents, client pre-approval for task tools, local OpenAI-compatible providers.

- ai_agents.runtime: "native" (runs in ops-ai-worker) or "external" (runs
  elsewhere, e.g. an external runtime such as opencode, and only reports its state).
- mcp_clients.auto_approve_tools: tools an administrator pre-approved for one
  client. Limited in code to app.mcp.catalog.AUTO_APPROVABLE.
- The provider kind "openai_compatible" needs no schema change (kind is free
  text validated in the API).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_agents", sa.Column("runtime", sa.String(20), nullable=False, server_default="native"))
    op.add_column("mcp_clients", sa.Column("auto_approve_tools", JSONB, nullable=False, server_default="[]"))


def downgrade():
    op.drop_column("mcp_clients", "auto_approve_tools")
    op.drop_column("ai_agents", "runtime")
