import os

import redis as redis_lib
from redis.sentinel import Sentinel

REDIS_SENTINELS = os.environ.get("REDIS_SENTINELS", "")
REDIS_MASTER_NAME = os.environ.get("REDIS_MASTER_NAME", "ops-center-redis")
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD", "")


def get_redis_client() -> redis_lib.Redis:
    """
    Sentinel-aware when REDIS_SENTINELS is configured (Phase 2) - see
    worker/redis_client.py's identical helper for the full rationale
    (duplicated here, not shared, since security/ is its own Docker build
    context, same as every other cross-cutting helper in this project).
    """
    if not REDIS_SENTINELS:
        return redis_lib.from_url(os.environ["REDIS_URL"])
    hosts = []
    for entry in REDIS_SENTINELS.split(","):
        host, port = entry.strip().split(":")
        hosts.append((host, int(port)))
    sentinel = Sentinel(hosts, socket_timeout=0.5)
    return sentinel.master_for(REDIS_MASTER_NAME, password=REDIS_PASSWORD or None)
