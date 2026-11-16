import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import get_settings
from app.models.security_feed import SecuritySource
from app.services.redis_client import get_redis_client

router = APIRouter()

# Every check runs concurrently under this limit, so the whole endpoint answers
# within about 3 s. The frontend and the container healthcheck rely on that: a
# slow probe here used to look like the backend being down.
_CHECK_TIMEOUT = 3.0
# refresh_security_feeds runs hourly (security/tasks.py) - generous slack
# for a slow run or a missed tick before calling it actually stale.
_SECURITY_FEED_STALE_AFTER = timedelta(hours=3)
_ALERTMANAGER_READY_URL = "http://alertmanager:9093/-/ready"
_GRAFANA_HEALTH_URL = "http://grafana:3000/api/health"

# This route needs no login, so request rate must not decide how much work it
# causes: callers within this window share one result, and at most one set of
# checks runs at a time.
_RESULT_TTL = 2.0
_cached_result: dict | None = None
_cached_at = 0.0
_running: asyncio.Task | None = None

# A separate small pool: background loops share the application pool, and a busy
# pool must not be reported as the database being down.
_probe_engine = create_async_engine(
    get_settings().database_url, pool_size=2, max_overflow=0, pool_timeout=1, pool_pre_ping=True
)


async def _database_ok() -> bool:
    async with _probe_engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return True


async def _redis_ok() -> bool:
    client = get_redis_client()
    try:
        await client.ping()
    finally:
        await client.aclose()
    return True


async def _http_ok(url: str) -> bool:
    async with httpx.AsyncClient(timeout=_CHECK_TIMEOUT) as client:
        return (await client.get(url)).status_code == 200


async def _security_feeds_ok() -> bool:
    async with AsyncSession(_probe_engine) as db:
        sources = (await db.execute(select(SecuritySource))).scalars().all()
    cutoff = datetime.now(timezone.utc) - _SECURITY_FEED_STALE_AFTER
    return bool(sources) and all(
        s.status == "ok" and s.last_success_at and s.last_success_at > cutoff for s in sources
    )


async def _status(check: Callable[[], Awaitable[bool]]) -> str:
    try:
        return "ok" if await asyncio.wait_for(check(), _CHECK_TIMEOUT) else "error"
    except Exception:
        return "error"


async def _collect() -> dict:
    settings = get_settings()
    checks: dict[str, Callable[[], Awaitable[bool]]] = {
        "database": _database_ok,
        "redis": _redis_ok,
        "loki": lambda: _http_ok(settings.loki_url),
        "security_feeds": _security_feeds_ok,
        "prometheus": lambda: _http_ok(f"{settings.prometheus_query_url.rstrip('/')}/-/ready"),
        "alertmanager": lambda: _http_ok(_ALERTMANAGER_READY_URL),
        "grafana": lambda: _http_ok(_GRAFANA_HEALTH_URL),
    }
    results = await asyncio.gather(*(_status(check) for check in checks.values()))
    components = dict(zip(checks, results))

    return {
        "status": "ok" if all(v == "ok" for v in components.values()) else "degraded",
        "app": settings.app_name,
        "version": settings.app_version,
        "components": components,
    }


@router.get("/health")
async def health() -> dict:
    """Liveness/readiness probe. Reports component status; never raises."""
    global _cached_result, _cached_at, _running
    if _cached_result is not None and time.monotonic() - _cached_at < _RESULT_TTL:
        return _cached_result
    if _running is None:
        _running = asyncio.create_task(_collect())
    task = _running
    # Shielded: one caller disconnecting must not cancel the shared checks.
    result = await asyncio.shield(task)
    if _running is task:
        _cached_result, _cached_at, _running = result, time.monotonic(), None
    return result
