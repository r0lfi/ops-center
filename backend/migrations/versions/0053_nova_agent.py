"""Nova: the owner's personal agent, plus per-agent dispatch targets.

- ai_agents.allowed_dispatch_targets: slugs an agent may delegate to with
  dispatch_to_agent. NULL keeps the earlier behaviour (every enabled native
  agent), so existing agents are unchanged.
- ai_agents.personal: a personal agent is never a dispatch target, its
  tasks are visible only to their owner and its tools are limited in code
  (app.models.ai.PERSONAL_AGENT_TOOLS).
- Seeds nova on the local "local-llm" provider. If that provider is missing
  or disabled, nova is created disabled without a provider so the owner
  picks one in the UI - never a silent fallback to a cloud provider.

Revision ID: 0053
Revises: 0052
Create Date: 2026-10-25
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0053"
down_revision = "0052"
branch_labels = None
depends_on = None

_NOVA_PROMPT = (
    "You are Nova, the owner's personal assistant in Ops Center. Over time you get to know the owner: "
    "conversations, routines, preferences and goals. Answer in the language the owner writes in. "
    "Be brief, friendly and direct, without long introductions.\n"
    "Use memory actively: search with recall_memory before asking the owner to repeat something, and use "
    "remember_fact when the owner asks you to remember something. Never say something is saved unless the "
    "tool confirmed it.\n"
    "You have no access to the infrastructure yourself. When the owner wants something checked or done on "
    "servers, containers, the network or services, send a short, precise task to coordinator with "
    "dispatch_to_agent. Include only what the task needs, no personal details. Say clearly that changes "
    "must be approved in Ops Center (Approvals, or an ACT code in Talk) before they run, and never say "
    "something is done before the result is in.\n"
    "You never send messages to other people in the owner's name. Use web_search and web_fetch when you "
    "need current information. Never store passwords, keys or other secrets."
)


def upgrade():
    op.add_column("ai_agents", sa.Column("allowed_dispatch_targets", JSONB, nullable=True))
    op.add_column("ai_agents", sa.Column("personal", sa.Boolean(), nullable=False, server_default="false"))
    conn = op.get_bind()
    local_llm_id = conn.execute(sa.text(
        "SELECT id FROM ai_providers WHERE slug = 'local-llm' AND enabled IS TRUE"
    )).scalar()
    op.execute(sa.text(
        """
        INSERT INTO ai_agents
            (slug, name, description, responsibility, status, provider_id, system_prompt,
             allowed_tools, allowed_hosts, allowed_environments, autonomy_level,
             max_tool_calls, max_execution_seconds, enabled, runtime,
             allowed_dispatch_targets, personal)
        SELECT
            'nova', 'Nova',
            'The owner''s personal assistant: remembers preferences and routines and asks Ops Center (Coordinator) for infrastructure work.',
            'Personal conversation, memory and suggestions. Infrastructure requests only via Coordinator with the normal approval.',
            CAST(:status AS varchar), CAST(:provider_id AS uuid), :system_prompt,
            '["web_search", "web_fetch", "dispatch_to_agent"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0,
            12, 900, CAST(:enabled AS boolean), 'native',
            '["coordinator"]'::jsonb, true
        WHERE NOT EXISTS (SELECT 1 FROM ai_agents WHERE slug = 'nova')
        """
    ).bindparams(provider_id=local_llm_id, system_prompt=_NOVA_PROMPT,
                 enabled=local_llm_id is not None, status="idle" if local_llm_id else "disabled"))


def downgrade():
    # Deleting nova would cascade to its conversations and notes, and other
    # agents may rely on the new columns. Refuse instead of losing data.
    conn = op.get_bind()
    nova_data = conn.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM ai_tasks t JOIN ai_agents a ON a.id = t.agent_id WHERE a.slug = 'nova')"
        " OR EXISTS (SELECT 1 FROM ai_memories m JOIN ai_agents a ON a.id = m.agent_id WHERE a.slug = 'nova')"
    )).scalar()
    if nova_data:
        raise RuntimeError("Cannot downgrade: nova has conversations or notes; preserve/export them first.")
    other_config = conn.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM ai_agents WHERE slug <> 'nova'"
        " AND (personal IS TRUE OR allowed_dispatch_targets IS NOT NULL))"
    )).scalar()
    if other_config:
        raise RuntimeError("Cannot downgrade: other agents use personal/allowed_dispatch_targets; reset them first.")
    op.execute(sa.text("DELETE FROM ai_agents WHERE slug = 'nova'"))
    op.drop_column("ai_agents", "personal")
    op.drop_column("ai_agents", "allowed_dispatch_targets")
