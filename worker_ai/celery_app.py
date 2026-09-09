import os

from celery import Celery
from celery.signals import worker_process_init

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

# ops-api enqueues onto this queue by name only ("worker_ai.tasks.run_agent_task",
# queue="ai") - it never imports this module, same relationship it has with
# worker.tasks and security.tasks.
celery_app = Celery("ops_center_ai", broker=_BROKER_URL, backend=_BROKER_URL, include=["worker_ai.tasks"])
if _TRANSPORT_OPTIONS:
    celery_app.conf.broker_transport_options = _TRANSPORT_OPTIONS
    celery_app.conf.result_backend_transport_options = _TRANSPORT_OPTIONS


@worker_process_init.connect
def _dispose_engine_after_fork(**kwargs) -> None:
    """See worker/celery_app.py's identical hook - same fork-safety
    reasoning applies to worker_ai.db's engine."""
    from worker_ai.db import engine

    engine.dispose()


celery_app.conf.update(
    task_track_started=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    task_default_queue="ai",
    # An agent run can involve several sequential tool calls (each a
    # blocking Ansible-job-and-wait, see ansible_ops.py) plus an LLM round
    # trip per step - generous but bounded so a stuck run doesn't hang a
    # worker slot forever. Individual agents also enforce their own
    # max_execution_seconds (app.models.ai.AIAgent) inside the run. Raised
    # from 600 alongside the General Agent's 900s budget for longer
    # web-research investigations.
    task_time_limit=1200,
)
