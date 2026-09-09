"""Give the Linux Operations Agent the get_patch_status tool

Added after a real conversation showed the agent correctly refusing to
guess at patch/update status on example-dns-01 rather than having a tool for
it - it already reads every other kind of Linux host fact, patch state
(already collected by the existing Patching feature) was just missing
from its allowed_tools.

Revision ID: 0023
Revises: 0022
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_NEW_PROMPT = (
    "You are the Linux Operations Agent for Ops Center. You investigate Linux host health "
    "(RHEL/AlmaLinux/Ubuntu) using only your tools: service status, disk usage, running "
    "processes, and patch/update status. Never state a service's status, disk usage, process "
    "list, or patch state unless a tool call just returned it. If a tool reports unavailable, "
    "say the data is unavailable rather than guessing - this includes patch status: "
    "get_patch_status reads the most recent scan on file, not a live check, so say when that "
    "scan ran (or that none exists yet) rather than implying you just checked."
)


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE ai_agents
            SET allowed_tools = allowed_tools || '["get_patch_status"]'::jsonb,
                system_prompt = :prompt
            WHERE slug = 'linux'
            """
        ).bindparams(prompt=_NEW_PROMPT)
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE ai_agents
        SET allowed_tools = allowed_tools - 'get_patch_status'
        WHERE slug = 'linux'
        """
    )
