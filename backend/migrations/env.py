from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_settings
from app.db.base import Base

# Import models here so Base.metadata is fully populated for autogenerate.
# (populated phase-by-phase as domain models are added)
from app.models import ai as _ai_models  # noqa: F401
from app.models import ai_memory as _ai_memory_models  # noqa: F401
from app.models import host as _host_models  # noqa: F401
from app.models import job as _job_models  # noqa: F401
from app.models import monitoring as _monitoring_models  # noqa: F401
from app.models import patch as _patch_models  # noqa: F401
from app.models import audit as _audit_models  # noqa: F401
from app.models import container as _container_models  # noqa: F401
from app.models import user as _user_models  # noqa: F401
from app.models import security_feed as _security_feed_models  # noqa: F401
from app.models import vulnerability as _vulnerability_models  # noqa: F401
from app.models import image_findings as _image_findings_models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url_sync)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
