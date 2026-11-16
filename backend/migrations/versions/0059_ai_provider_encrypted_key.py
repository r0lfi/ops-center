"""Store AI provider API keys encrypted in the database.

Key files under secrets_root/ai-providers exist only on the node whose API
saved them, so the AI worker on the other node failed with "No such file".
New saves also store the key encrypted (Fernet, derived from API_SECRET_KEY)
in ai_providers.encrypted_key, which every node reads. Upgrade copies each
existing key file it can read on this node into the column; key files are
left in place as a fallback and are not changed.

Revision ID: 0059
Revises: 0058
Create Date: 2026-11-13
"""
import sqlalchemy as sa
from alembic import op

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_providers", sa.Column("encrypted_key", sa.Text(), nullable=True))
    from pathlib import Path

    from app.core.config import get_settings
    from app.core.provider_keys import encrypt_provider_key

    root = Path(get_settings().secrets_root).resolve()
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT id, secret_path FROM ai_providers WHERE secret_path IS NOT NULL AND encrypted_key IS NULL"
    )).all()
    for provider_id, secret_path in rows:
        path = (root / secret_path).resolve()
        if not str(path).startswith(str(root) + "/") or not path.is_file():
            continue  # stays on the file fallback; saving the key again stores it
        key = path.read_text().strip()
        if key:
            bind.execute(sa.text("UPDATE ai_providers SET encrypted_key = :key WHERE id = :id"),
                         {"key": encrypt_provider_key(key), "id": provider_id})


def downgrade():
    # Keys saved after 0059 also exist as a file on the node that saved them.
    op.drop_column("ai_providers", "encrypted_key")
