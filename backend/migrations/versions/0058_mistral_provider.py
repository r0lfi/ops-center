"""Seed a Mistral AI provider row.

The row is created disabled and keyless, like the OpenAI/Ollama rows in
0021: an admin sets the API key and enables it under Settings -> AI
Providers, then points agents at it. No agent is moved. The kind is free
text (validated in the API), so no schema change is needed.

Downgrade removes the row only while no agent uses it, so agents are never
silently detached from their provider.

Revision ID: 0058
Revises: 0057
Create Date: 2026-11-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0058"
down_revision = "0057"
branch_labels = None
depends_on = None

PROVIDER_MISTRAL = "10000000-0000-0000-0000-000000000004"


def upgrade():
    # An admin may already have created a "mistral" slug by hand; keep it.
    op.execute(sa.text(
        "INSERT INTO ai_providers (id, slug, kind, display_name, default_model, enabled) "
        "VALUES (CAST(:id AS uuid), 'mistral', 'mistral', 'Mistral AI', 'mistral-large-4', false) "
        "ON CONFLICT DO NOTHING"
    ).bindparams(id=PROVIDER_MISTRAL))


def downgrade():
    bind = op.get_bind()
    in_use = bind.execute(sa.text(
        "SELECT count(*) FROM ai_agents WHERE provider_id = CAST(:id AS uuid)"
    ), {"id": PROVIDER_MISTRAL}).scalar()
    if in_use:
        raise RuntimeError("Mistral provider is still used by agents; move them to another provider first")
    bind.execute(sa.text("DELETE FROM ai_providers WHERE id = CAST(:id AS uuid)"), {"id": PROVIDER_MISTRAL})
