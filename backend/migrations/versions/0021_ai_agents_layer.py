"""AI Operations layer (Phase 1): providers, agents, tasks, findings

Coordinator + Linux + Monitoring agents are seeded here, all pointed at an
"anthropic" provider row created with no key yet - the admin fills that in
via the AI Agents page (Settings -> AI Providers), never via .env. Two more
provider rows (openai, ollama) are seeded disabled/keyless so the UI has
something to configure without a second migration.

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PROVIDER_ANTHROPIC = "10000000-0000-0000-0000-000000000001"
PROVIDER_OPENAI = "10000000-0000-0000-0000-000000000002"
PROVIDER_OLLAMA = "10000000-0000-0000-0000-000000000003"

AGENT_COORDINATOR = "20000000-0000-0000-0000-000000000001"
AGENT_LINUX = "20000000-0000-0000-0000-000000000002"
AGENT_MONITORING = "20000000-0000-0000-0000-000000000003"

_COORDINATOR_PROMPT = (
    "You are the Coordinator Agent for Ops Center, a homelab infrastructure "
    "platform. You never guess infrastructure state. For any question about "
    "real systems, delegate to specialist agents via dispatch_to_agent and "
    "base your final answer only on what they actually reported. If a "
    "specialist reports a data source was unavailable, say so plainly - "
    "never fill the gap with a plausible-sounding guess. Keep the final "
    "answer concise and operational: likely cause, evidence, recommendation."
)
_LINUX_PROMPT = (
    "You are the Linux Operations Agent for Ops Center. You investigate "
    "Linux host health (RHEL/AlmaLinux/Ubuntu) using only your tools: "
    "service status, disk usage, and running processes. Never state a "
    "service's status, disk usage, or process list unless a tool call just "
    "returned it. If a tool reports unavailable, say the data is "
    "unavailable rather than guessing."
)
_MONITORING_PROMPT = (
    "You are the Monitoring Agent for Ops Center. You investigate "
    "Prometheus metrics, Alertmanager alerts, and Loki logs. Never state a "
    "metric value, alert, or log line unless a tool call just returned it. "
    "If Prometheus, Alertmanager, or Loki report unavailable, say so "
    "plainly rather than guessing at a value."
)


def upgrade() -> None:
    op.create_table(
        "ai_providers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(50), nullable=False, unique=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("base_url", sa.String(500)),
        sa.Column("default_model", sa.String(200)),
        sa.Column("secret_path", sa.String(500)),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "ai_agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(50), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("responsibility", sa.Text),
        sa.Column("status", sa.String(20), nullable=False, server_default="idle"),
        sa.Column("current_task", sa.String(500)),
        sa.Column("error_message", sa.Text),
        sa.Column(
            "provider_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ai_providers.id", ondelete="SET NULL"),
        ),
        sa.Column("model", sa.String(200)),
        sa.Column("system_prompt", sa.Text, nullable=False, server_default=""),
        sa.Column("allowed_tools", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("allowed_hosts", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("allowed_environments", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("autonomy_level", sa.Integer, nullable=False, server_default="0"),
        sa.Column("max_tool_calls", sa.Integer, nullable=False, server_default="8"),
        sa.Column("max_execution_seconds", sa.Integer, nullable=False, server_default="90"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("last_activity_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ai_agents_status", "ai_agents", ["status"])

    op.create_table(
        "ai_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ai_agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("requested_by", sa.String(100)),
        sa.Column("source", sa.String(20), nullable=False, server_default="web"),
        sa.Column("input_message", sa.Text, nullable=False),
        sa.Column("response_message", sa.Text),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("celery_task_id", sa.String(100)),
        sa.Column("error_message", sa.Text),
        sa.Column("agents_used", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("tools_used", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("data_sources", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("confidence", sa.Integer),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("duration_ms", sa.Integer),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ai_tasks_agent_id", "ai_tasks", ["agent_id"])
    op.create_index("ix_ai_tasks_status", "ai_tasks", ["status"])
    op.create_index("ix_ai_tasks_created_at", "ai_tasks", ["created_at"])

    op.create_table(
        "ai_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ai_agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="CASCADE")
        ),
        sa.Column("host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="SET NULL")),
        sa.Column("severity", sa.String(20), nullable=False, server_default="info"),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("evidence", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ai_findings_agent_id", "ai_findings", ["agent_id"])
    op.create_index("ix_ai_findings_task_id", "ai_findings", ["task_id"])
    op.create_index("ix_ai_findings_host_id", "ai_findings", ["host_id"])
    op.create_index("ix_ai_findings_created_at", "ai_findings", ["created_at"])

    # bulk_insert (not a raw f-string INSERT) so SQLAlchemy handles quoting -
    # the prompt text below contains apostrophes ("service's status") that
    # would otherwise break a hand-built SQL string.
    providers_table = sa.table(
        "ai_providers",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("slug", sa.String),
        sa.column("kind", sa.String),
        sa.column("display_name", sa.String),
        sa.column("default_model", sa.String),
        sa.column("enabled", sa.Boolean),
    )
    op.bulk_insert(
        providers_table,
        [
            {
                "id": PROVIDER_ANTHROPIC,
                "slug": "anthropic",
                "kind": "anthropic",
                "display_name": "Anthropic Claude",
                "default_model": "claude-sonnet-5",
                "enabled": True,
            },
            {
                "id": PROVIDER_OPENAI,
                "slug": "openai",
                "kind": "openai",
                "display_name": "OpenAI",
                "default_model": "gpt-4o",
                "enabled": False,
            },
            {
                "id": PROVIDER_OLLAMA,
                "slug": "ollama",
                "kind": "ollama",
                "display_name": "Local Ollama",
                "default_model": "llama3.1",
                "enabled": False,
            },
        ],
    )

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
                "id": AGENT_COORDINATOR,
                "slug": "coordinator",
                "name": "Coordinator Agent",
                "description": (
                    "Main AI interface - receives operator questions, delegates to specialist "
                    "agents, and returns one correlated answer."
                ),
                "responsibility": (
                    "Understand operational intent, decide which specialist agents are needed, "
                    "delegate, and combine results."
                ),
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _COORDINATOR_PROMPT,
                "allowed_tools": ["dispatch_to_agent"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 6,
                "max_execution_seconds": 120,
                "enabled": True,
            },
            {
                "id": AGENT_LINUX,
                "slug": "linux",
                "name": "Linux Operations Agent",
                "description": "Linux server health across RHEL, AlmaLinux, and Ubuntu.",
                "responsibility": "systemd service status, disk/filesystem usage, running processes.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _LINUX_PROMPT,
                "allowed_tools": ["get_service_status", "get_disk_usage", "get_running_processes"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
            {
                "id": AGENT_MONITORING,
                "slug": "monitoring",
                "name": "Monitoring Agent",
                "description": "Prometheus metrics, Alertmanager alerts, and Loki log correlation.",
                "responsibility": "Infrastructure metrics, alert correlation, log search.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _MONITORING_PROMPT,
                "allowed_tools": ["get_server_metrics", "get_alerts", "search_logs"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
        ],
    )


def downgrade() -> None:
    op.drop_table("ai_findings")
    op.drop_table("ai_tasks")
    op.drop_table("ai_agents")
    op.drop_table("ai_providers")
