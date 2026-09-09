"""Containers Agent gains get_container_env_keys (read) and container_exec (write, gated)

Closes the exact gap a real Containers-agent investigation hit: it could
see a generic error in the app logs but had no way to check whether a
required env var was even set, or to run a one-off command (e.g. curl)
inside the container to tell an auth failure from a network failure.
get_container_env_keys only ever returns variable NAMES, never values,
so it can't leak a secret; container_exec is unrestricted execution
scoped to inside one container, so it's always approval-gated exactly
like run_shell_command (see worker_ai/ai/tools/exec_tools.py).

Revision ID: 0030
Revises: 0029
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: Union[str, None] = "0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TOOLS = ["get_container_env_keys", "container_exec"]


def upgrade() -> None:
    for tool in _TOOLS:
        op.execute(
            sa.text(
                "UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST(:tool AS text)) "
                "WHERE slug = 'container' AND NOT allowed_tools @> to_jsonb(ARRAY[CAST(:tool AS text)])"
            ).bindparams(tool=tool)
        )


def downgrade() -> None:
    for tool in _TOOLS:
        op.execute(
            sa.text(
                "UPDATE ai_agents SET allowed_tools = allowed_tools - CAST(:tool AS text) WHERE slug = 'container'"
            ).bindparams(tool=tool)
        )
