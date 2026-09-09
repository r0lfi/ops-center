from functools import lru_cache

from celery import Celery

from app.core.config import get_settings


def _broker_config() -> tuple[str, dict]:
    settings = get_settings()
    if not settings.redis_sentinels:
        return settings.redis_url, {}
    hosts = [h.strip() for h in settings.redis_sentinels.split(",") if h.strip()]
    url = ";".join(f"sentinel://:{settings.redis_password}@{h}" for h in hosts) + "/0"
    return url, {"master_name": settings.redis_master_name}


@lru_cache
def get_celery_client() -> Celery:
    """
    A Celery client for *submitting* tasks only - ops-api never imports
    ansible-runner or executes playbooks itself, per project policy. The
    actual task body lives in worker/tasks.py, run by ops-worker.

    Sentinel-aware when REDIS_SENTINELS is configured (Phase 2): broker/
    backend become Kombu's `sentinel://` scheme instead of a fixed redis://
    host, so a Redis failover doesn't require restarting this client.
    """
    broker_url, transport_options = _broker_config()
    app = Celery("ops_center_client", broker=broker_url, backend=broker_url)
    if transport_options:
        app.conf.broker_transport_options = transport_options
        app.conf.result_backend_transport_options = transport_options
    return app
