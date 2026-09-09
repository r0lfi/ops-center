from functools import lru_cache

import redis.asyncio as redis
from redis.asyncio.sentinel import Sentinel

from app.core.config import get_settings


def _parse_sentinels(raw: str) -> list[tuple[str, int]]:
    hosts = []
    for entry in raw.split(","):
        host, port = entry.strip().split(":")
        hosts.append((host, int(port)))
    return hosts


@lru_cache
def _sentinel() -> Sentinel | None:
    settings = get_settings()
    if not settings.redis_sentinels:
        return None
    return Sentinel(_parse_sentinels(settings.redis_sentinels), socket_timeout=0.5)


def get_redis_client() -> redis.Redis:
    """
    Sentinel-aware when REDIS_SENTINELS is configured (Phase 2) - the
    returned client re-asks Sentinel for the current master on each new
    connection, so it follows a Redis failover automatically. Falls back to
    a plain client against REDIS_URL when Sentinel isn't configured, same
    as every call site behaved before Phase 2.
    """
    settings = get_settings()
    sentinel = _sentinel()
    if sentinel is None:
        return redis.from_url(settings.redis_url)
    return sentinel.master_for(settings.redis_master_name, password=settings.redis_password or None)
