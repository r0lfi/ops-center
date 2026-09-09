"""app_catalog_settings table

Single-row table for the App Catalog's one global setting (the template
list URL) - see backend/app/models/app_catalog.py for why this isn't a
generic key-value settings framework yet.

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-03

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SINGLETON_ID = "00000000-0000-0000-0000-000000000001"
DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/SelfhostedPro/selfhosted_templates/master/Template/template.json"


def upgrade() -> None:
    op.create_table(
        "app_catalog_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("template_url", sa.String(1000), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()),
    )
    op.execute(
        f"INSERT INTO app_catalog_settings (id, template_url) VALUES ('{SINGLETON_ID}', '{DEFAULT_TEMPLATE_URL}')"
    )


def downgrade() -> None:
    op.drop_table("app_catalog_settings")
