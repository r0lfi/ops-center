"""Owner-only status and connection test of nova's read-only data sources.

Sources are configured by an administrator in NOVA_DATA_SOURCES with the
credential as a file under the secrets root (docs/nova.md); this API only
shows the signed-in owner their own sources and whether they answer. It never
returns credentials.
"""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.ai import AIAgent
from app.models.user import User
from app.services import nova_sources

router = APIRouter()


def source_read(source, provider_kind):
    cloud = provider_kind in nova_sources.CLOUD_KINDS
    return {"kind": source.kind, "label": nova_sources.LABELS[source.kind], "host": urlsplit(source.url).hostname,
            "calendars": source.calendars, "task_lists": source.task_lists, "entities": source.entities,
            "allow_cloud": source.allow_cloud, "secret_present": nova_sources.secret_present(source),
            "offered": not cloud or source.allow_cloud,
            "tools": [s["name"] for s in nova_sources.SCHEMAS[source.kind]]}


async def _provider_kind(db) -> str | None:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "nova", AIAgent.personal.is_(True)))).scalar_one_or_none()
    if agent is None or agent.provider_id is None:
        return None
    await db.refresh(agent, ["provider"])
    return agent.provider.kind if agent.provider else None


@router.get("/ai/nova/data-sources")
async def list_sources(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    kind = await _provider_kind(db)
    return {"cloud_provider": kind in nova_sources.CLOUD_KINDS,
            "sources": [source_read(s, kind) for s in nova_sources.sources_for(user.id)]}


@router.post("/ai/nova/data-sources/test")
async def test_sources(user: User = Depends(get_current_user)):
    results = []
    for source in nova_sources.sources_for(user.id):
        error = await run_in_threadpool(nova_sources.check, source)
        results.append({"kind": source.kind, "ok": error is None, "error": error})
    return {"results": results}
