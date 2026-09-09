import os

from celery import Celery
from celery.schedules import crontab
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

celery_app = Celery(
    "ops_center_worker",
    broker=_BROKER_URL,
    backend=_BROKER_URL,
    include=["worker.tasks", "worker.scheduled_tasks"],
)
if _TRANSPORT_OPTIONS:
    celery_app.conf.broker_transport_options = _TRANSPORT_OPTIONS
    celery_app.conf.result_backend_transport_options = _TRANSPORT_OPTIONS


@worker_process_init.connect
def _dispose_engine_after_fork(**kwargs) -> None:
    """worker.db's engine (and worker.tasks' redis_client) are created at
    import time, in the MainProcess, before --concurrency forks the
    ForkPoolWorker children below. A pooled DB connection checked out
    pre-fork would otherwise be a live socket shared by two processes -
    dispose() drops any such inherited connections so each child opens
    its own on first use instead. redis-py's own pool already does this
    same PID-based reset internally, so it needs no equivalent call here."""
    from worker.db import engine

    engine.dispose()

celery_app.conf.update(
    task_track_started=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    beat_schedule={
        "reconcile-service-checks": {
            "task": "worker.scheduled_tasks.reconcile_service_checks",
            "schedule": 120.0,
        },
        "run-scheduled-patch-groups": {
            "task": "worker.scheduled_tasks.run_scheduled_patch_groups",
            "schedule": 60.0,
        },
        "sync-remote-container-inventory": {
            "task": "worker.scheduled_tasks.sync_remote_container_inventory",
            "schedule": 300.0,
        },
        "check-camera-connectivity": {
            "task": "worker.scheduled_tasks.check_camera_connectivity",
            "schedule": 60.0,
        },
        "reboot-check-all": {
            "task": "worker.scheduled_tasks.reboot_check_all",
            "schedule": 21600.0,  # 6 hours
        },
        "nightly-patch-scan": {
            "task": "worker.scheduled_tasks.nightly_patch_scan",
            "schedule": crontab(hour=2, minute=30),
        },
        "nightly-host-vuln-scan": {
            "task": "worker.scheduled_tasks.nightly_host_vuln_scan",
            "schedule": crontab(hour=3, minute=30),
        },
        "nightly-container-vuln-scan": {
            "task": "security.tasks.scan_local_images",
            "schedule": crontab(hour=3, minute=0),
            "options": {"queue": "security"},
        },
        "sync-container-status": {
            "task": "security.tasks.sync_container_status",
            "schedule": 120.0,
            "options": {"queue": "security"},
        },
        "hourly-security-feeds": {
            "task": "security.tasks.refresh_security_feeds",
            "schedule": crontab(minute=15),  # hourly, offset from other jobs
            "options": {"queue": "security"},
        },
        # More scheduled jobs (Renovate, DB maintenance) arrive with the
        # phases that give them somewhere to store their results.
    },
)

# celery-redbeat: a Redis-backed schedule + distributed lock (instead of
# vanilla beat's local schedule file), so it's safe to run more than one
# ops-scheduler at once - only the lock-holder actually fires jobs. Not
# needed yet (only one ops-scheduler runs, on docker-01) but wired in now
# since it needs the same Sentinel-aware Redis config being set up in this
# file for Phase 2 anyway, and it's what Phase 3's active/active app tier
# will need to run more than one ops-scheduler safely. beat_schedule above
# is still the source of truth - RedBeatScheduler loads it into Redis.
if REDIS_SENTINELS:
    _sentinel_hosts = [tuple(h.strip().split(":")) for h in REDIS_SENTINELS.split(",") if h.strip()]
    celery_app.conf.redbeat_redis_url = "redis-sentinel://"
    celery_app.conf.redbeat_redis_options = {
        "sentinels": [(host, int(port)) for host, port in _sentinel_hosts],
        "service_name": REDIS_MASTER_NAME,
        "password": REDIS_PASSWORD or None,
    }
else:
    celery_app.conf.redbeat_redis_url = REDIS_URL
