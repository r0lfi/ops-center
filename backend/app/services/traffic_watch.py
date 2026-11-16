"""Durable configurable collectors, reconciled on every API node.

The database is the source of truth. A per-source transaction lock prevents two
HA nodes from committing the same read concurrently. Credentials and host-key
pins come only from onboarded Host records, never from log or settings input.
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import shlex
import time
import uuid
from pathlib import Path
import asyncssh
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload
from app.core.config import get_settings
from app.db.session import async_session_factory
from app.models.host import Host
from app.models.traffic import TrafficCollector
from app.services.connectivity import _resolve_secret, _PinnedHostKeyClient
from app.services.redis_client import get_redis_client
from app.services.traffic_settings import load_config, enabled_sources

logger = logging.getLogger("traffic_watch")
REDIS_SNAPSHOT_KEY = "traffic_watch:snapshot"
REDIS_SNAPSHOT_TTL = 300
LEASE_PREFIX = "traffic_watch:lease:"
LEASE_TTL = 60
COLLECT_TIMEOUT = 45
_RELEASE_SCRIPT = (
    "if redis.call('get', KEYS[1]) == ARGV[1] then "
    "return redis.call('del', KEYS[1]) end return 0"
)
_redis_client = None
_tasks = set()
_running = {}
_geoip_reader = None


def _geolocate(ip):
    global _geoip_reader
    if _geoip_reader is None:
        path = Path(get_settings().geoip_db_path)
        if not path.is_file():
            return None, None, None, None
        import maxminddb

        _geoip_reader = maxminddb.open_database(str(path))
    try:
        record = _geoip_reader.get(ip) or {}
    except ValueError:
        return None, None, None, None
    location = record.get("location", {})
    return (
        location.get("latitude"),
        location.get("longitude"),
        record.get("city", {}).get("names", {}).get("en"),
        record.get("country", {}).get("names", {}).get("en"),
    )


def _is_private_ip(ip):
    try:
        return not ipaddress.ip_address(ip).is_global
    except ValueError:
        return True


def _is_suspicious(status):
    return status is not None and status >= 400


class _RemoteTail:
    def __init__(self, host):
        self.host = host
        self.conn = None

    async def run(self, command, stdin=None):
        if self.conn is None:
            h = self.host
            if not h.credential or not h.ssh_host_fingerprint:
                raise ValueError(
                    "Complete managed SSH onboarding before enabling this source"
                )
            secret = _resolve_secret(h.credential.secret_path)
            kwargs = {
                "host": h.ip_address,
                "port": h.ssh_port,
                "username": h.ssh_user,
                # Explicit empty known-hosts list invokes our fingerprint validator. None
                # would disable host-key validation in AsyncSSH.
                "known_hosts": [],
                "config": None,
                "client_factory": lambda: _PinnedHostKeyClient(h.ssh_host_fingerprint),
                "connect_timeout": 8,
            }
            if h.credential.credential_type == "ssh_key":
                kwargs["client_keys"] = [
                    asyncssh.import_private_key(secret.read_text())
                ]
            elif h.credential.credential_type == "ssh_password":
                kwargs.update(password=secret.read_text().strip(), client_keys=[])
            else:
                raise ValueError("Unsupported managed credential type")
            self.conn = await asyncssh.connect(**kwargs)
        result = await self.conn.run(command, input=stdin, check=False, timeout=30)
        if result.exit_status != 0:
            raise RuntimeError(
                "Remote reader failed; check configured path, format and sudo permissions"
            )
        if len(result.stdout) > 8 * 1024 * 1024:
            raise ValueError("Remote result exceeds collection limit")
        return result.stdout

    async def close(self):
        if self.conn:
            self.conn.close()
            await self.conn.wait_closed()
            self.conn = None


async def _collect(tail, source, checkpoint):
    config = source.model_dump(mode="json")
    config["hostname"] = tail.host.hostname
    names = {"ssh": "traffic_ssh_reader.py", "wireguard": "traffic_wireguard_reader.py"}
    reader = (
        Path(__file__)
        .with_name(names.get(source.kind, "traffic_reader.py"))
        .read_text()
    )
    request = (
        config
        if source.kind == "wireguard"
        else {"source": source.kind, "config": config, "checkpoint": checkpoint}
    )
    # Reader source and request travel over stdin, not argv: sudo logs the full command
    # line to /var/log/secure, and the script used to be logged on every poll (GBs/day).
    command = (
        ("sudo -n " if source.use_sudo else "")
        + "python3 -c "
        + shlex.quote(
            "import sys;l=sys.stdin.readline();sys.argv=['-c',l];exec(sys.stdin.read())"
        )
    )
    return json.loads(await tail.run(command, stdin=json.dumps(request) + "\n" + reader))


async def _publish_snapshot():
    from app.services.traffic_store import recent

    payload = await recent(time.time() - 86400)
    payload["events"] = payload["events"][:100]
    await _redis().set(REDIS_SNAPSHOT_KEY, json.dumps(payload), ex=REDIS_SNAPSHOT_TTL)


def _redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = get_redis_client()
    return _redis_client


async def _acquire_lease(name, token):
    """Best effort: avoids both nodes reading the same source. Correctness does
    not depend on it; the commit below discards a read another node beat us to."""
    try:
        return bool(
            await _redis().set(LEASE_PREFIX + name, token, nx=True, ex=LEASE_TTL)
        )
    except Exception:
        return True


async def _release_lease(name, token):
    try:
        await _redis().eval(_RELEASE_SCRIPT, 1, LEASE_PREFIX + name, token)
    except Exception:
        pass


def _prepare_events(source, rows, since, now):
    events = []
    for row in rows:
        if not since <= row["ts"] <= now + 60:
            continue
        if source.kind not in ("ssh", "auth_audit") and _is_private_ip(row["ip"]):
            continue
        lat, lon, city, country = _geolocate(row["ip"])
        row.update(
            source=source.id,
            lat=lat,
            lon=lon,
            city=city,
            country=country,
            suspicious=_is_suspicious(row["status"])
            or row.get("signal") in ("auth_failure", "auth_throttled"),
        )
        events.append(row)
    return events


async def _collect_source(tail, source, host, signature, interval, lock):
    from app.services.traffic_store import save_batch

    # The DB pool is shared with the API. Never hold a connection while waiting
    # on SSH: a slow or unreachable host used to pin one connection per source
    # and starve every API request (QueuePool timeouts -> HTTP 500).
    async with async_session_factory() as db:
        cursor = await db.get(TrafficCollector, source.id)
    seen = cursor.last_success if cursor else None
    cp = (
        cursor.checkpoint
        if cursor and cursor.checkpoint.get("signature") == signature
        else {}
    )
    if cp and seen and time.time() - seen < interval:
        return
    # Configuration edits start from the new source's current log tail; old
    # authentication events are never replayed.
    since = cp.get("since", time.time())
    result = await asyncio.wait_for(_collect(tail, source, cp), COLLECT_TIMEOUT)
    now = time.time()
    events = _prepare_events(source, result["events"], since, now)
    checkpoint = result["checkpoint"]
    checkpoint.update(signature=signature, since=since)
    if host.latitude is not None and host.longitude is not None:
        checkpoint["destinations"] = {
            source.id: {
                "lat": host.latitude,
                "lon": host.longitude,
                "city": None,
                "country": None,
                "label": source.label,
            }
        }
    async with async_session_factory() as db, db.begin():
        if not await db.scalar(
            text("SELECT pg_try_advisory_xact_lock(73810,:key)"), {"key": lock}
        ):
            return
        current = await db.get(
            TrafficCollector, source.id, with_for_update=True, populate_existing=True
        )
        # Another node committed a read from the same checkpoint meanwhile.
        if (current.last_success if current else None) != seen:
            return
        await save_batch(db, source.id, events, checkpoint, now)


async def _record_failure(source_id):
    message = "Source unavailable: check SSH onboarding, log path and reader permissions"
    try:
        async with async_session_factory() as db, db.begin():
            await db.execute(
                insert(TrafficCollector)
                .values(name=source_id, checkpoint={}, last_error=message)
                .on_conflict_do_update(
                    index_elements=["name"], set_={"last_error": message}
                )
            )
    except Exception:
        # Must never end the source loop; the next pass retries.
        logger.warning("Could not record failure for traffic source %s", source_id)


async def _source_loop(source, host, signature):
    tail = _RemoteTail(host)
    interval = 15 if source.kind == "wireguard" else 5
    lock = int.from_bytes(
        hashlib.sha256(source.id.encode()).digest()[:4], "big", signed=True
    )
    token = uuid.uuid4().hex
    try:
        while True:
            try:
                if await _acquire_lease(source.id, token):
                    try:
                        await _collect_source(
                            tail, source, host, signature, interval, lock
                        )
                    finally:
                        await _release_lease(source.id, token)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await tail.close()
                logger.warning(
                    "Traffic source %s failed; checkpoint retained (%s: %s)",
                    source.id,
                    type(exc).__name__,
                    str(exc)[:200],
                )
                await _record_failure(source.id)
            await asyncio.sleep(interval)
    finally:
        await tail.close()


async def _snapshot_loop():
    # One summary for the AI network tool every 30 s, instead of a 1000-row
    # query after every collection pass of every source.
    while True:
        try:
            await _publish_snapshot()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Traffic snapshot publish failed")
        await asyncio.sleep(30)


async def _supervise():
    while True:
        try:
            config = await load_config()
            sources = enabled_sources(config)
            async with async_session_factory() as db:
                hosts = (
                    (
                        await db.execute(
                            select(Host)
                            .where(Host.id.in_([s.host_id for s in sources]))
                            .options(selectinload(Host.credential))
                        )
                    )
                    .scalars()
                    .all()
                )
            hosts = {h.id: h for h in hosts}
            desired = {}
            for source in sources:
                host = hosts.get(source.host_id)
                if host is None:
                    continue
                identity = [
                    source.model_dump(mode="json"),
                    host.ip_address,
                    host.ssh_port,
                    host.ssh_user,
                    host.ssh_host_fingerprint,
                    str(host.credential_id),
                    host.latitude,
                    host.longitude,
                ]
                signature = hashlib.sha256(
                    json.dumps(identity, sort_keys=True).encode()
                ).hexdigest()
                desired[source.id] = (source, host, signature)
            for name, (signature, task) in list(_running.items()):
                if name not in desired or desired[name][2] != signature or task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    del _running[name]
            for name, (source, host, signature) in desired.items():
                if name not in _running:
                    _running[name] = (
                        signature,
                        asyncio.create_task(_source_loop(source, host, signature)),
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Traffic configuration could not be reconciled")
        await asyncio.sleep(10)


async def _retention_loop():
    from app.services.traffic_store import cleanup

    while True:
        try:
            async with async_session_factory() as db, db.begin():
                if await db.scalar(text("SELECT pg_try_advisory_xact_lock(738104)")):
                    await cleanup(db, time.time())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Traffic retention pass failed")
        await asyncio.sleep(300)


async def start_traffic_watch():
    from app.services.traffic_security import security_loop

    for coro in (_supervise(), _retention_loop(), _snapshot_loop(), security_loop()):
        task = asyncio.create_task(coro)
        _tasks.add(task)


async def stop_traffic_watch():
    tasks = list(_tasks) + [task for _, task in _running.values()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _tasks.clear()
    _running.clear()
