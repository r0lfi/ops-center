"""Add the General Agent - real shell access across the whole fleet

A deliberately different kind of agent from Coordinator/Linux/Monitoring:
those three only ever call a small, fixed set of read-only (or always-
approval-gated) tools. The General Agent gets run_shell_command instead -
real SSH access to any managed host, over the exact same Ansible
connectivity the rest of the app already trusts. Every command, not just
ones that look destructive, requires human approval before it runs (see
worker_ai/ai/tools/shell_tools.py's docstring) - a heuristic "only gate
destructive-looking commands" design was considered and deliberately
dropped in favor of always requiring approval.

Revision ID: 0025
Revises: 0024
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: Union[str, None] = "0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AGENT_GENERAL = "20000000-0000-0000-0000-000000000004"
PROVIDER_ANTHROPIC = "10000000-0000-0000-0000-000000000001"

_PROMPT = (
    "You are the General Agent for Ops Center - a general-purpose investigation and execution "
    "agent, not limited to a fixed set of infrastructure checks like the other agents here. You "
    "have shell access (run_shell_command) over SSH to every managed host, as root, with the same "
    "reach a human operator already has - but every single command you propose, no matter how "
    "safe it looks, requires a human to approve it in Ops Center before it runs. Propose one "
    "focused command at a time, explain what it will do and why, then wait - tell the user it "
    "requires approval and give them the request code. This is real production infrastructure "
    "people depend on. Never state a fact about a host's state unless a command you actually ran "
    "and got a result for said so."
)


def upgrade() -> None:
    agents_table = sa.table(
        "ai_agents",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("slug", sa.String),
        sa.column("name", sa.String),
        sa.column("description", sa.Text),
        sa.column("responsibility", sa.Text),
        sa.column("status", sa.String),
        sa.column("provider_id", postgresql.UUID(as_uuid=True)),
        sa.column("system_prompt", sa.Text),
        sa.column("allowed_tools", postgresql.JSONB),
        sa.column("allowed_hosts", postgresql.JSONB),
        sa.column("allowed_environments", postgresql.JSONB),
        sa.column("autonomy_level", sa.Integer),
        sa.column("max_tool_calls", sa.Integer),
        sa.column("max_execution_seconds", sa.Integer),
        sa.column("enabled", sa.Boolean),
    )
    op.bulk_insert(
        agents_table,
        [
            {
                "id": AGENT_GENERAL,
                "slug": "general",
                "name": "General Agent",
                "description": (
                    "General-purpose investigation and execution agent with real shell access "
                    "across the homelab - not limited to Ops Center's own infrastructure tools."
                ),
                "responsibility": "Anything that needs a real command run on a real host.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _PROMPT,
                "allowed_tools": ["run_shell_command"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 1,
                "max_tool_calls": 20,
                "max_execution_seconds": 300,
                "enabled": True,
            }
        ],
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM ai_agents WHERE id = '{AGENT_GENERAL}'")
