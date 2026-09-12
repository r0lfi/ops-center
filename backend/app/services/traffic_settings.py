"""Database-backed traffic settings shared by all API nodes.

Reads are deliberately uncached: collectors reconcile within ten seconds and
authorization/configuration changes do not require a deployment or local files.
"""

from sqlalchemy import select
from app.db.session import async_session_factory
from app.models.traffic import TrafficSettings
from app.schemas.traffic_settings import TrafficSettingsConfig


async def load_config(db=None):
    if db is None:
        async with async_session_factory() as session:
            return await load_config(session)
    row = await db.get(TrafficSettings, 1)
    return TrafficSettingsConfig.model_validate(
        {**(row.value if row else {}), "revision": row.revision if row else 0}
    )


def enabled_sources(config):
    return [s for s in config.sources if s.enabled] if config.enabled else []


def source_summaries(config, collectors):
    states = {c.name: c for c in collectors}
    result = []
    for source in enabled_sources(config):
        state = states.get(source.id)
        checkpoint = state.checkpoint if state else {}
        result.append(
            {
                "name": source.id,
                "label": source.label,
                "kind": source.kind,
                "last_success": state.last_success if state else None,
                "error": state.last_error if state else None,
                "files": checkpoint.get("file_count", 0),
                "warning": (
                    "Journal history gap"
                    if checkpoint.get("history_gap")
                    else "Collector backlog" if checkpoint.get("backlog") else None
                ),
            }
        )
    return result
