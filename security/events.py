"""
Continuous local Docker event collection - a background thread, not a
Celery task, started once via @worker_ready (see security/celery_app.py)
after the worker process is fully up. Deliberately not a Celery task:
security-worker runs --concurrency=1, so a task that never returns would
permanently occupy the only worker slot, starving every other action
(start/stop/restart, image pulls, stack ops). Only ever runs for
ops-host - remote hosts have no persistent channel to stream from (the
same constraint Logs/Stats hit in Phase 1); their Events tab gets a
bounded one-shot `docker events --since --until` window per request
instead (ansible/playbooks/docker-events.yml), never touching this table.
"""

import json
import subprocess
import threading
import time
from datetime import datetime, timezone

from app.models.container import DockerEvent
from security.db import SessionLocal

from app.core.config import get_settings

LOCAL_HOSTNAME = get_settings().ops_local_hostname
_RECONNECT_DELAY_SECONDS = 5
_MAX_TRACKED = 5000
# Used only by the single listener thread.
_healthcheck_commands: dict[str, str | None] = {}
_healthcheck_exec_ids: set[str] = set()


def _truncated(value: str | None, max_len: int) -> str | None:
    return value[:max_len] if value else value


def _healthcheck_command(container_id: str | None) -> str | None:
    """The command Docker reports in exec_create for this container's
    healthcheck. Failures are not cached, so a brief daemon error only means a
    few healthcheck events get stored."""
    if not container_id:
        return None
    if container_id in _healthcheck_commands:
        return _healthcheck_commands[container_id]
    try:
        output = subprocess.run(
            ["docker", "inspect", "--format", "{{json .Config.Healthcheck}}", container_id],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
        test = (json.loads(output) or {}).get("Test") or []
    except (subprocess.SubprocessError, OSError, ValueError, AttributeError):
        return None
    command = None
    if test[:1] == ["CMD"]:
        command = " ".join(test[1:])
    elif test[:1] == ["CMD-SHELL"]:
        command = "/bin/sh -c " + " ".join(test[1:])
    if len(_healthcheck_commands) >= _MAX_TRACKED:
        _healthcheck_commands.clear()
    _healthcheck_commands[container_id] = command
    return command


def _is_healthcheck_exec(raw: dict) -> bool:
    """Every container healthcheck emits exec_create, exec_start and exec_die.
    Those made up nearly all of this table, over 100 000 rows a day, and grew
    it to 37 GB in two months, so they are not stored. Any other exec is someone
    running a command inside a container: that is an audit trail and is kept,
    including when the command or exec ID cannot be matched to a healthcheck."""
    action = str(raw.get("Action") or raw.get("status") or "")
    if not action.startswith("exec_"):
        return False
    actor = raw.get("Actor") or {}
    exec_id = (actor.get("Attributes") or {}).get("execID")
    if not exec_id:
        return False
    if action.startswith("exec_create: "):
        command = _healthcheck_command(actor.get("ID") or raw.get("id"))
        if command is None or action[len("exec_create: "):] != command:
            return False
        if len(_healthcheck_exec_ids) >= _MAX_TRACKED:
            _healthcheck_exec_ids.clear()
        _healthcheck_exec_ids.add(exec_id)
        return True
    if action.startswith("exec_die"):
        if exec_id in _healthcheck_exec_ids:
            _healthcheck_exec_ids.discard(exec_id)
            return True
        return False
    return exec_id in _healthcheck_exec_ids


def _store_event(raw: dict) -> None:
    actor = raw.get("Actor") or {}
    time_value = raw.get("time")
    occurred_at = (
        datetime.fromtimestamp(time_value, tz=timezone.utc) if time_value else datetime.now(timezone.utc)
    )

    db = SessionLocal()
    try:
        db.add(
            DockerEvent(
                hostname=LOCAL_HOSTNAME,
                event_type=_truncated(raw.get("Type") or "unknown", 30),
                action=_truncated(raw.get("Action") or raw.get("status") or "unknown", 255),
                actor_id=_truncated(actor.get("ID") or raw.get("id"), 128),
                actor_attributes=actor.get("Attributes") or {},
                occurred_at=occurred_at,
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001 - one bad event must never kill the listener thread
        db.rollback()
        print(f"[docker-events] failed to store event: {exc}", flush=True)
    finally:
        db.close()


def _stream_forever() -> None:
    print("[docker-events] listener starting", flush=True)
    while True:
        try:
            proc = subprocess.Popen(
                ["docker", "events", "--format", "{{json .}}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    if not _is_healthcheck_exec(event):
                        _store_event(event)
                except (ValueError, TypeError):
                    continue
        except Exception as exc:  # noqa: BLE001 - the daemon restarting must not permanently kill collection
            print(f"[docker-events] stream error, reconnecting: {exc}", flush=True)
        # `docker events` exited (daemon restart, transient error) - wait a
        # moment and reconnect rather than silently stopping collection for
        # the rest of the container's life.
        time.sleep(_RECONNECT_DELAY_SECONDS)


def start() -> None:
    threading.Thread(target=_stream_forever, name="docker-events-listener", daemon=True).start()
