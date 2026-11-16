import json
import logging
import socket
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from croniter import croniter
from app.core.config import get_settings
from sqlalchemy import bindparam, func, or_, select, text, update

from app.models.host import GROUP_PATCH_PLAYBOOKS, GROUP_PATCH_TYPES, Host, HostGroup
from app.models.job import PATCH_PLAYBOOKS, AnsibleJob
from app.models.monitoring import MonitoringCheck
from worker.celery_app import celery_app
from worker.db import SessionLocal
from worker.redis_client import get_redis_client
from worker.tasks import run_playbook
from worker.unifi_client import UnifiCredentialsMissing, kick_camera

# Cron expressions on host_groups are entered and interpreted in this
# timezone (matches TZ in .env), not UTC - "Monday 15:00" should mean local
# wall-clock 15:00, correctly across DST, not a fixed UTC offset computed
# once at creation time.
_SCHEDULE_TZ = ZoneInfo(get_settings().tz)

_logger = logging.getLogger("camera_watchdog")

_WATCHDOG_CAMERAS = get_settings().camera_watchdog_targets
_RTSP_PORT = 554
_CHECK_TIMEOUT = 3.0
_FAILURE_THRESHOLD = 3  # consecutive failed checks (~3 min at 60s cadence) before kicking
_FAILURE_KEY_TTL = 900  # 15 min - self-clears stale state after a missed tick/restart
_COOLDOWN_SECONDS = 900  # 15 min between kicks per camera - give WiFi time to recover


def _submit(db, host: Host, playbook: str, extra_vars: dict) -> None:
    job = AnsibleJob(
        playbook=playbook,
        target_description=f"scheduled:{host.hostname}",
        extra_vars=extra_vars,
        status="queued",
    )
    db.add(job)
    db.commit()
    run_playbook.delay(str(job.id), [str(host.id)], playbook, None, extra_vars)


@celery_app.task(name="worker.scheduled_tasks.reconcile_service_checks")
def reconcile_service_checks() -> None:
    """Every ~2 minutes: re-check each host's explicitly monitored systemd
    units and publish fresh node_exporter textfile metrics for them."""
    db = SessionLocal()
    try:
        checks = db.execute(
            select(MonitoringCheck).where(
                MonitoringCheck.check_type == "systemd_unit", MonitoringCheck.enabled.is_(True)
            )
        ).scalars().all()

        units_by_host: dict[uuid.UUID, list[str]] = defaultdict(list)
        for check in checks:
            units_by_host[check.host_id].append(check.target)

        if not units_by_host:
            return

        hosts = db.execute(select(Host).where(Host.id.in_(units_by_host.keys()))).scalars().all()
        for host in hosts:
            if not host.monitoring_enabled:
                continue
            _submit(db, host, "service-check.yml", {"services": units_by_host[host.id]})
    finally:
        db.close()


@celery_app.task(name="worker.scheduled_tasks.reboot_check_all")
def reboot_check_all() -> None:
    """Every 6 hours: refresh reboot-required status for every monitored host."""
    db = SessionLocal()
    try:
        hosts = db.execute(select(Host).where(Host.monitoring_enabled.is_(True))).scalars().all()
        for host in hosts:
            _submit(db, host, "reboot-check.yml", {})
    finally:
        db.close()


@celery_app.task(name="worker.scheduled_tasks.nightly_host_vuln_scan")
def nightly_host_vuln_scan() -> None:
    """Every night: collect the installed-package inventory for every
    monitored host and hand it to security-worker for Trivy correlation."""
    db = SessionLocal()
    try:
        hosts = db.execute(select(Host).where(Host.monitoring_enabled.is_(True))).scalars().all()
        for host in hosts:
            _submit(db, host, "vulnerability-scan.yml", {})
    finally:
        db.close()


@celery_app.task(name="worker.scheduled_tasks.sync_remote_container_inventory")
def sync_remote_container_inventory() -> None:
    """Every ~5 minutes: container-inventory.yml over SSH for every managed
    host except ops-host itself - that one is already synced directly
    by security-worker over docker.sock every ~2 minutes (see
    security/tasks.py sync_container_status). Running it against
    ops-host too would just be a redundant SSH round-trip to inspect
    the same docker daemon Ops Center already has direct socket access
    to."""
    db = SessionLocal()
    try:
        hosts = db.execute(
            select(Host).where(Host.monitoring_enabled.is_(True), Host.hostname != get_settings().ops_local_hostname)
        ).scalars().all()
        for host in hosts:
            _submit(db, host, "container-inventory.yml", {})
    finally:
        db.close()


def _is_reachable(ip: str) -> bool:
    try:
        with socket.create_connection((ip, _RTSP_PORT), timeout=_CHECK_TIMEOUT):
            return True
    except OSError:
        return False


_LAST_KICK_TTL = 2592000  # 30 days - this is history for the Cameras page, not live state


def _record_last_kick(redis_client, name: str, result: str) -> None:
    """Written for backend/app/api/routes/cameras.py to read - the only
    piece of watchdog state that isn't already derivable from the plain
    fails/cooldown counters."""
    payload = json.dumps({"at": datetime.now(timezone.utc).isoformat(), "result": result})
    redis_client.set(f"camera_watchdog:last_kick:{name}", payload, ex=_LAST_KICK_TTL)


@celery_app.task(name="worker.scheduled_tasks.check_camera_connectivity")
def check_camera_connectivity() -> None:
    """Every ~60s: TCP-probe each Tapo camera's RTSP port. Confirmed (see
    the investigation this task came out of) that these cameras don't just
    suffer weak-signal packet loss - they periodically disassociate from
    WiFi entirely and stay down for hours, regardless of individual signal
    quality, and nothing currently makes them reconnect on their own.
    After _FAILURE_THRESHOLD consecutive failures, force re-association via
    the UniFi controller's kick-sta (the one mechanism confirmed to
    actually recover a stuck camera), then hold a per-camera cooldown -
    a kick isn't always instantly effective, so this avoids hammering the
    AP while giving the WiFi stack real time to recover."""
    redis_client = get_redis_client()
    for name, ip in _WATCHDOG_CAMERAS:
        fail_key = f"camera_watchdog:fails:{name}"
        cooldown_key = f"camera_watchdog:cooldown:{name}"

        if _is_reachable(ip):
            redis_client.delete(fail_key)
            continue

        fail_count = redis_client.incr(fail_key)
        redis_client.expire(fail_key, _FAILURE_KEY_TTL)

        if fail_count < _FAILURE_THRESHOLD or redis_client.exists(cooldown_key):
            continue

        redis_client.set(cooldown_key, "1", ex=_COOLDOWN_SECONDS)
        try:
            kicked = kick_camera(ip)
        except UnifiCredentialsMissing as exc:
            _logger.error("camera watchdog: cannot kick %s (%s): %s", name, ip, exc)
            _record_last_kick(redis_client, name, "error")
            continue
        except Exception:
            _logger.exception("camera watchdog: kick-sta failed for %s (%s)", name, ip)
            _record_last_kick(redis_client, name, "error")
            continue

        if kicked:
            _logger.warning(
                "camera watchdog: kicked %s (%s) off WiFi after %d consecutive failed RTSP checks",
                name, ip, fail_count,
            )
            _record_last_kick(redis_client, name, "kicked")
        else:
            _logger.warning(
                "camera watchdog: %s (%s) down %d checks but not currently a known UniFi WiFi client - can't kick",
                name, ip, fail_count,
            )
            _record_last_kick(redis_client, name, "not_found")


@celery_app.task(name="worker.scheduled_tasks.nightly_patch_scan")
def nightly_patch_scan() -> None:
    """Every night: patch availability scan only. Actual installation is
    never triggered automatically here - that stays opt-in per host/group
    via security_patch_policy/auto_patch, and is a separate explicit action."""
    db = SessionLocal()
    try:
        hosts = db.execute(
            select(Host).where(Host.monitoring_enabled.is_(True), Host.security_patch_policy != "disabled")
        ).scalars().all()
        for host in hosts:
            _submit(db, host, "patch-check.yml", {})
    finally:
        db.close()


def _cron_matches_this_minute(cron_expression: str, local_now: datetime) -> bool:
    this_minute = local_now.replace(second=0, microsecond=0)
    itr = croniter(cron_expression, this_minute - timedelta(minutes=1))
    return itr.get_next(datetime) == this_minute


@celery_app.task(name="worker.scheduled_tasks.run_scheduled_patch_groups")
def run_scheduled_patch_groups() -> None:
    """
    Every minute: check every host_group with an active schedule
    (schedule_enabled AND cron_expression set) against the current time in
    configured timezone, and submit a patch-security.yml/patch-all.yml job for the
    whole group's member hosts if this minute matches.

    This is the one place in the app where patching runs without an
    explicit human action per run - everywhere else "actual patch
    installation is never automatic" (see nightly_patch_scan above).
    Deliberately scoped to opt-in, named, auto-patch groups only - a host
    is never auto-patched just by existing.

    De-duplication: last_triggered_at is claimed atomically via a single
    conditional UPDATE (see below) before any job is submitted, so a beat
    schedule tick landing slightly early/late, or this task overlapping
    with itself under Celery's at-least-once delivery (e.g. a redelivery
    after a worker restart), can never double-submit the same group's
    patch job within the same matching minute. A plain read-then-write
    (read last_triggered_at, decide, write it back later) would NOT be
    safe here - two overlapping instances could both read the stale value
    before either writes, and both would submit. The UPDATE ... WHERE ...
    RETURNING below is a single statement, so Postgres's row lock makes
    only one of two concurrent claims win.
    """
    local_now = datetime.now(tz=_SCHEDULE_TZ)
    db = SessionLocal()
    try:
        groups = db.execute(
            select(HostGroup).where(
                HostGroup.schedule_enabled.is_(True), HostGroup.cron_expression.isnot(None)
            )
        ).scalars().all()

        for group in groups:
            if not _cron_matches_this_minute(group.cron_expression, local_now):
                continue

            if group.patch_type not in GROUP_PATCH_TYPES:
                continue

            hosts = db.execute(select(Host).join(Host.groups).where(HostGroup.id == group.id)).scalars().all()
            if not hosts:
                continue

            # Atomic claim for this local minute: succeeds only if
            # last_triggered_at is still NULL or from before this minute
            # started. Whichever concurrent instance's UPDATE commits
            # first wins the row lock; the other's WHERE clause then no
            # longer matches (last_triggered_at was just moved forward),
            # so it updates zero rows and RETURNING gives it back nothing.
            utc_minute_start = local_now.replace(second=0, microsecond=0).astimezone(timezone.utc)
            claimed = db.execute(
                update(HostGroup)
                .where(
                    HostGroup.id == group.id,
                    or_(HostGroup.last_triggered_at.is_(None), HostGroup.last_triggered_at < utc_minute_start),
                )
                .values(last_triggered_at=datetime.now(timezone.utc))
                .returning(HostGroup.id)
            ).first()
            db.commit()
            if claimed is None:
                # Another (possibly concurrent) run already claimed this
                # group for this minute - don't submit a duplicate job.
                continue

            playbook = GROUP_PATCH_PLAYBOOKS[group.patch_type]
            extra_vars = {"batch_size": group.batch_size}

            job = AnsibleJob(
                playbook=playbook,
                target_description=f"group:{group.name} ({len(hosts)} hosts, scheduled)",
                extra_vars=extra_vars,
                status="queued",
            )
            db.add(job)
            db.commit()

            run_playbook.delay(str(job.id), [str(h.id) for h in hosts], playbook, None, extra_vars)
    finally:
        db.close()


_PRUNE_BATCH_ROWS = 5000
_PRUNE_BATCH_PAUSE_SECONDS = 0.2
_PRUNE_BUDGET_SECONDS = 600  # Keeps WAL volume and replication lag in check.

_PRUNE_DOCKER_EVENTS = text(
    """
    DELETE FROM docker_events WHERE id IN (
        SELECT id FROM docker_events
        WHERE hostname = :hostname AND occurred_at < :cutoff
        ORDER BY occurred_at LIMIT :limit
    )
    """
)
_PRUNE_ANSIBLE_EVENTS = text(
    """
    DELETE FROM ansible_events WHERE id IN (
        SELECT e.id FROM ansible_events e JOIN ansible_jobs j ON j.id = e.job_id
        WHERE e.created_at < :cutoff AND j.playbook NOT IN :keep
        LIMIT :limit
    )
    """
).bindparams(bindparam("keep", expanding=True))
# A loose index scan: finds the few hostnames without reading 30M+ rows.
_DOCKER_EVENT_HOSTNAMES = text(
    """
    WITH RECURSIVE h(name) AS (
        SELECT min(hostname) FROM docker_events
        UNION ALL
        SELECT (SELECT min(hostname) FROM docker_events WHERE hostname > h.name)
        FROM h WHERE h.name IS NOT NULL
    )
    SELECT name FROM h WHERE name IS NOT NULL
    """
)


def _prune_in_batches(db, statement, params: dict, deadline: float) -> int:
    """Short transactions, so replication and normal writes keep up. An
    unfinished table simply continues on the next hourly run."""
    removed = 0
    while time.monotonic() < deadline:
        count = db.execute(statement, {**params, "limit": _PRUNE_BATCH_ROWS}).rowcount
        db.commit()
        removed += count
        if count < _PRUNE_BATCH_ROWS:
            break
        time.sleep(_PRUNE_BATCH_PAUSE_SECONDS)
    return removed


@celery_app.task(name="worker.scheduled_tasks.prune_event_tables")
def prune_event_tables() -> None:
    """Enforce event_retention_days on the two unbounded event tables, except
    patch jobs' events: they are the patch history. Beat fires this once an
    hour; the batched deletes are also safe if two overlap."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=get_settings().event_retention_days)
    deadline = time.monotonic() + _PRUNE_BUDGET_SECONDS
    db = SessionLocal()
    try:
        removed = 0
        for hostname in db.execute(_DOCKER_EVENT_HOSTNAMES).scalars().all():
            removed += _prune_in_batches(
                db, _PRUNE_DOCKER_EVENTS, {"hostname": hostname, "cutoff": cutoff}, deadline
            )
        removed_ansible = _prune_in_batches(
            db, _PRUNE_ANSIBLE_EVENTS, {"cutoff": cutoff, "keep": list(PATCH_PLAYBOOKS)}, deadline
        )
        _logger.info("Pruned %s docker_events and %s ansible_events rows", removed, removed_ansible)
    finally:
        db.close()


_PRUNE_AI_TRAFFIC_EVENTS = text(
    "DELETE FROM ai_traffic_events WHERE id IN "
    "(SELECT id FROM ai_traffic_events WHERE ts < :cutoff ORDER BY ts LIMIT :limit)"
)
_PRUNE_AI_TRACE_SPANS = text(
    "DELETE FROM ai_trace_spans WHERE span_id IN "
    "(SELECT span_id FROM ai_trace_spans WHERE started_at < :cutoff ORDER BY started_at LIMIT :limit)"
)


@celery_app.task(name="worker.scheduled_tasks.prune_ai_traffic")
def prune_ai_traffic() -> None:
    """AI Traffic Monitor: enforce its own retention (ai_traffic_settings),
    delete PCAPs past their expiry and forget per-process telemetry counters
    of worker processes that stopped reporting a day ago."""
    deadline = time.monotonic() + _PRUNE_BUDGET_SECONDS
    db = SessionLocal()
    try:
        days = db.execute(text("SELECT retention_days FROM ai_traffic_settings WHERE id = 1")).scalar() or 30
        cutoff = datetime.now(timezone.utc) - timedelta(days=int(days))
        events = _prune_in_batches(db, _PRUNE_AI_TRAFFIC_EVENTS, {"cutoff": cutoff}, deadline)
        spans = _prune_in_batches(db, _PRUNE_AI_TRACE_SPANS, {"cutoff": cutoff}, deadline)
        captures = db.execute(text(
            "DELETE FROM ai_traffic_captures WHERE expires_at < now() "
            "OR (status IN ('pending', 'running') AND requested_at < now() - interval '1 hour')")).rowcount
        db.execute(text(
            "UPDATE ai_traffic_sources SET stats = jsonb_set(stats, '{processes}', coalesce(("
            "  SELECT jsonb_object_agg(k, v) FROM jsonb_each(stats->'processes') AS p(k, v) "
            "  WHERE (v->>'ts')::float8 > extract(epoch FROM now()) - 86400), '{}'::jsonb)) "
            "WHERE kind = 'app' AND stats ? 'processes'"))
        db.commit()
        _logger.info("Pruned %s AI traffic events, %s spans, %s captures", events, spans, captures)
    finally:
        db.close()


@celery_app.task(name="worker.scheduled_tasks.reap_orphaned_jobs")
def reap_orphaned_jobs() -> None:
    """A worker that dies mid-job (restart, failover, full disk) never records
    an outcome, so its row stayed queued or running forever and looked active
    in the UI. Report what is actually known: the job did not finish under
    our control. "cancelled" rather than "failed" because patch reports treat
    it as an unknown outcome, and the playbook may well have completed.

    A queued job reaped here will not start later: run_playbook refuses to claim
    it. A job that really is still running after this long is left alone and
    records its real outcome when it ends; aborting a patch run mid-way because
    of its age would be worse than a temporarily wrong status."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=get_settings().orphaned_job_after_hours)
    db = SessionLocal()
    try:
        reaped = db.execute(
            update(AnsibleJob)
            .where(
                AnsibleJob.status.in_(("queued", "running")),
                func.coalesce(AnsibleJob.started_at, AnsibleJob.created_at) < cutoff,
            )
            .values(status="cancelled", finished_at=datetime.now(timezone.utc))
        ).rowcount
        db.commit()
        if reaped:
            _logger.warning("Marked %s orphaned Ansible jobs as cancelled", reaped)
    finally:
        db.close()
