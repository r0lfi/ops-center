"""AI Operations layer (Phase 4): approval workflow for write/execute tools

Gives the Linux Operations Agent restart_service, run_ansible_job, and
reboot_host - none of which execute anything directly (see
worker_ai/ai/actions.py and exec_tools.py): calling one just creates a
pending ai_actions row, requiring a human to approve it via
POST /api/ai/actions/{id}/approve (operator minimum, admin for the
level-3 reboot_host) before worker_ai/tasks.py's execute_action_task ever
touches the host.

Revision ID: 0024
Revises: 0023
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_actions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("request_code", sa.String(50), nullable=False, unique=True),
        sa.Column(
            "agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("task_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")),
        sa.Column("host_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("hosts.id", ondelete="SET NULL")),
        sa.Column("action", sa.String(500), nullable=False),
        sa.Column("tool", sa.String(100), nullable=False),
        sa.Column("arguments", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("approval_level", sa.Integer, nullable=False, server_default="2"),
        sa.Column("risk", sa.String(20), nullable=False, server_default="medium"),
        sa.Column("reason", sa.Text),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("source", sa.String(20), nullable=False, server_default="web"),
        sa.Column("requested_by", sa.String(100)),
        sa.Column("approved_by", sa.String(100)),
        sa.Column("result", postgresql.JSONB),
        sa.Column("requested_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("executed_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_ai_actions_agent_id", "ai_actions", ["agent_id"])
    op.create_index("ix_ai_actions_task_id", "ai_actions", ["task_id"])
    op.create_index("ix_ai_actions_host_id", "ai_actions", ["host_id"])
    op.create_index("ix_ai_actions_status", "ai_actions", ["status"])

    op.execute(
        """
        UPDATE ai_agents
        SET allowed_tools = allowed_tools || '["restart_service", "run_ansible_job", "reboot_host"]'::jsonb
        WHERE slug = 'linux'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE ai_agents
        SET allowed_tools = allowed_tools - 'restart_service' - 'run_ansible_job' - 'reboot_host'
        WHERE slug = 'linux'
        """
    )
    op.drop_table("ai_actions")
