from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter
from sqlalchemy import select, text

from app.core.config import get_settings
from app.db.session import async_session_factory, engine
from app.models.security_feed import SecuritySource
from app.services.redis_client import get_redis_client

router = APIRouter()

_LOKI_TIMEOUT = 5.0
# refresh_security_feeds runs hourly (security/tasks.py) - generous slack
# for a slow run or a missed tick before calling it actually stale.
_SECURITY_FEED_STALE_AFTER = timedelta(hours=3)


@router.get("/health")
async def health() -> dict:
    """Liveness/readiness probe. Reports component status; never raises."""
    settings = get_settings()
    components: dict[str, str] = {}

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        components["database"] = "ok"
    except Exception:
        components["database"] = "error"

    try:
        redis_client = get_redis_client()
        await redis_client.ping()
        await redis_client.aclose()
        components["redis"] = "ok"
    except Exception:
        components["redis"] = "error"

    try:
        async with httpx.AsyncClient(timeout=_LOKI_TIMEOUT) as client:
            resp = await client.get(settings.loki_url)
        components["loki"] = "ok" if resp.status_code == 200 else "error"
    except Exception:
        components["loki"] = "error"

    try:
        async with async_session_factory() as db:
            sources = (await db.execute(select(SecuritySource))).scalars().all()
        cutoff = datetime.now(timezone.utc) - _SECURITY_FEED_STALE_AFTER
        components["security_feeds"] = (
            "ok"
            if sources
            and all(s.status == "ok" and s.last_success_at and s.last_success_at > cutoff for s in sources)
            else "error"
        )
    except Exception:
        components["security_feeds"] = "error"

    overall = "ok" if all(v == "ok" for v in components.values()) else "degraded"

    return {
        "status": overall,
        "app": settings.app_name,
        "version": settings.app_version,
        "components": components,
    }
