import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Verified live (fetched and inspected the real JSON) before picking this as
# the default: Portainer template spec v2, a mix of type 1 (single
# container) and type 3 (compose stack via a `repository: {url, stackfile}`
# pointing at a second file) - see app/services/app_templates.py for the
# parser. Admin-editable via AppCatalogSettings below, not hardcoded
# anywhere else.
DEFAULT_TEMPLATE_URL = "https://raw.githubusercontent.com/SelfhostedPro/selfhosted_templates/master/Template/template.json"

# Fixed id for the one settings row - see AppCatalogSettings docstring.
SINGLETON_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


class AppCatalogSettings(Base):
    """Single-row table (always SINGLETON_ID) - the App Catalog has exactly
    one global setting right now (the template list URL), so this is a
    dedicated table rather than standing up a generic key-value settings
    framework a single value doesn't justify yet. Same secret-free-config
    style as Registry - a URL is not a secret."""

    __tablename__ = "app_catalog_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    template_url: Mapped[str] = mapped_column(String(1000), nullable=False, default=DEFAULT_TEMPLATE_URL)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
