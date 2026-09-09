"""Add a Chat Agent for general/casual questions, teach Coordinator to route to it

Real request: the Coordinator's job is homelab infrastructure - it has no
business answering "how much does a horse weigh" itself, and specialist
agents (container/linux/security/...) would misfire trying to treat it as
an infra question. This adds a dedicated "chat" agent scoped to general
knowledge/casual conversation (web_search/web_fetch only, no infra tools,
no approval-gated actions) and tells the Coordinator to dispatch anything
that isn't actually about this platform's own systems to it. Defaults to
the already-working Anthropic provider; an admin can repoint it at OpenAI
from the Agents page once a key is set on that provider (no code change
needed - this is exactly what the create/configure-agent UI is for).

Revision ID: 0031
Revises: 0030
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: Union[str, None] = "0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_CHAT_SYSTEM_PROMPT = (
    "You are the Chat Agent for Ops Center. You answer general-knowledge and "
    "casual questions that have nothing to do with this platform's own "
    "infrastructure (e.g. facts, definitions, weather, conversions, trivia). "
    "You are not an infrastructure agent - never claim to check or affect any "
    "real host, container, or service; if a question turns out to actually be "
    "about this platform's infrastructure, say so plainly instead of guessing. "
    "Use web_search/web_fetch when a question needs current or verifiable "
    "information you're not confident about. Keep answers short and direct."
)

_COORDINATOR_ADDENDUM = (
    " If the user's question is general knowledge or casual conversation - "
    "not about this platform's own infrastructure - dispatch it to the chat "
    "agent instead of a specialist agent."
)


def upgrade() -> None:
    conn = op.get_bind()
    anthropic_id = conn.execute(
        sa.text("SELECT id FROM ai_providers WHERE slug = 'anthropic'")
    ).scalar()

    op.execute(
        sa.text(
            """
            INSERT INTO ai_agents
                (slug, name, description, responsibility, status, provider_id,
                 system_prompt, allowed_tools, allowed_hosts, allowed_environments,
                 autonomy_level, max_tool_calls, max_execution_seconds, enabled)
            SELECT
                'chat', 'Chat Agent',
                'Answers general-knowledge and casual questions - not an infrastructure agent.',
                'General knowledge, casual conversation, quick lookups unrelated to Ops Center itself.',
                'idle', :provider_id, :system_prompt,
                '["web_search", "web_fetch"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
                0, 8, 90, true
            WHERE NOT EXISTS (SELECT 1 FROM ai_agents WHERE slug = 'chat')
            """
        ).bindparams(provider_id=anthropic_id, system_prompt=_CHAT_SYSTEM_PROMPT)
    )

    op.execute(
        sa.text(
            "UPDATE ai_agents SET system_prompt = system_prompt || CAST(:addendum AS text) "
            "WHERE slug = 'coordinator' AND system_prompt NOT LIKE '%dispatch it to the chat agent%'"
        ).bindparams(addendum=_COORDINATOR_ADDENDUM)
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM ai_agents WHERE slug = 'chat'"))
    op.execute(
        sa.text(
            "UPDATE ai_agents SET system_prompt = replace(system_prompt, CAST(:addendum AS text), '') "
            "WHERE slug = 'coordinator'"
        ).bindparams(addendum=_COORDINATOR_ADDENDUM)
    )
