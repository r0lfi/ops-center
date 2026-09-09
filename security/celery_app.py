import os

from celery import Celery
from celery.signals import worker_process_init, worker_ready

REDIS_URL = os.environ["REDIS_URL"]
REDIS_SENTINELS = os.environ.get("REDIS_SENTINELS", "")
REDIS_MASTER_NAME = os.environ.get("REDIS_MASTER_NAME", "ops-center-redis")
REDIS_PASSWORD = os.environ.get("REDIS_PASSWORD", "")


def _broker_config() -> tuple[str, dict]:
    if not REDIS_SENTINELS:
        return REDIS_URL, {}
    hosts = [h.strip() for h in REDIS_SENTINELS.split(",") if h.strip()]
    url = ";".join(f"sentinel://:{REDIS_PASSWORD}@{h}" for h in hosts) + "/0"
    return url, {"master_name": REDIS_MASTER_NAME}


_BROKER_URL, _TRANSPORT_OPTIONS = _broker_config()

# The scheduling itself lives in worker/celery_app.py's beat_schedule (one
# beat process for the whole system, routing to this queue via
# options={"queue": "security"}) - this app only needs to consume tasks.
celery_app = Celery("ops_center_security", broker=_BROKER_URL, backend=_BROKER_URL, include=["security.tasks"])
if _TRANSPORT_OPTIONS:
    celery_app.conf.broker_transport_options = _TRANSPORT_OPTIONS
    celery_app.conf.result_backend_transport_options = _TRANSPORT_OPTIONS


@worker_process_init.connect
def _dispose_engine_after_fork(**kwargs) -> None:
    """See worker/celery_app.py's identical hook - same fork-safety
    reasoning applies to security.db's engine."""
    from security.db import engine

    engine.dispose()


@worker_ready.connect
def _start_event_listener(**kwargs) -> None:
    # Fires once in the main process when the worker is fully up (unlike
    # worker_process_init above, which fires per forked child) - exactly
    # once is what we want for a single continuous background thread. See
    # security/events.py for why this is a thread and not a Celery task.
    from security.events import start as start_event_listener

    start_event_listener()


celery_app.conf.update(
    task_track_started=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    task_default_queue="security",
)
