"""General Agent gains read-only Ops Center codebase tools

list_repo_files/read_repo_file/search_code (worker_ai/ai/tools/code_tools.py)
let the General Agent answer "why does X behave like that" by reading the
actual source instead of guessing - scoped to files git actually tracks
(never .env/secrets), over a read-only bind mount (see compose.yml).

Revision ID: 0029
Revises: 0028
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: Union[str, None] = "0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TOOLS = ["list_repo_files", "read_repo_file", "search_code"]


def upgrade() -> None:
    for tool in _TOOLS:
        op.execute(
            sa.text(
                "UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST(:tool AS text)) "
                "WHERE slug = 'general' AND NOT allowed_tools @> to_jsonb(ARRAY[CAST(:tool AS text)])"
            ).bindparams(tool=tool)
        )


def downgrade() -> None:
    for tool in _TOOLS:
        op.execute(
            sa.text(
                "UPDATE ai_agents SET allowed_tools = allowed_tools - CAST(:tool AS text) WHERE slug = 'general'"
            ).bindparams(tool=tool)
        )
