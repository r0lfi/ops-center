"""Optional SSH log collection for the traffic map. Configure source hosts explicitly."""

import asyncio
import ipaddress
import json
import logging
import re
import shlex
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path

import asyncssh
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.db.session import async_session_factory
from app.models.host import Host
from app.services.connectivity import _resolve_secret
from app.services.redis_client import get_redis_client

logger = logging.getLogger("traffic_watch")

POLL_INTERVAL = 3.0
RECONNECT_DELAY = 15.0
MAX_EVENTS = 1000
HOME_DEST_REFRESH_S = 6 * 3600
REDIS_SNAPSHOT_KEY = "traffic_watch:snapshot"
# Generous vs. POLL_INTERVAL - a brief Redis blip shouldn't blank out
# worker_ai's Network Agent tool (see that tool's docstring) between ticks.
REDIS_SNAPSHOT_TTL = 300
_SNAPSHOT_EVENT_COUNT = 100
# NPM's proxy-host-*_access.log set changes as hosts are added/removed -
# re-glob occasionally rather than every tick (cheap, but no need every 3s).
NPM_REGLOB_EVERY_N_TICKS = 20

_NPM_LOG_RE = re.compile(
    r'^\[[^\]]*\]\s+\S+\s+\S+\s+(?P<status>\d+)\s+-\s+\S+\s+\S+\s+'
    r'(?P<domain>\S+)\s+"[^"]*"\s+\[Client\s+(?P<ip>[^\]]+)\]'
)


@dataclass
class TrafficEvent:
    id: str
    ts: float
    ip: str
    lat: float | None
    lon: float | None
    city: str | None
    country: str | None
    domain: str
    status: int | None
    source: str  # "edge-host" | "home"
    suspicious: bool


class _State:
    events: deque[TrafficEvent] = deque(maxlen=MAX_EVENTS)
    dest_points: dict[str, dict] = {}
    geoip_reader = None
    geoip_load_failed = False


_state = _State()


def _load_geoip():
    if _state.geoip_reader is not None or _state.geoip_load_failed:
        return _state.geoip_reader
    import maxminddb

    path = Path(get_settings().geoip_db_path)
    if not path.exists():
        logger.warning("GeoIP database not found at %s - Traffic Map will show no locations", path)
        _state.geoip_load_failed = True
        return None
    try:
        _state.geoip_reader = maxminddb.open_database(str(path))
    except Exception:
        logger.exception("failed to open GeoIP database at %s", path)
        _state.geoip_load_failed = True
    return _state.geoip_reader


def _geolocate(ip: str) -> tuple[float | None, float | None, str | None, str | None]:
    reader = _load_geoip()
    if reader is None:
        return None, None, None, None
    try:
        record = reader.get(ip)
    except Exception:
        return None, None, None, None
    if not record:
        return None, None, None, None
    location = record.get("location") or {}
    city = (record.get("city") or {}).get("names", {}).get("en")
    country = (record.get("country") or {}).get("names", {}).get("en")
    return location.get("latitude"), location.get("longitude"), city, country


def _is_private_ip(ip: str) -> bool:
    """LAN clients (RFC1918, loopback, link-local, ULA) hitting a proxy on
    its internal address - own devices reaching Jellyfin/Ops Center itself
    from inside the house, health checks, etc. Not "traffic from outside"
    in the sense this map is for, so these are dropped before ever
    becoming an event rather than shown as an "unknown" location."""
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True  # unparseable - never show it rather than risk a bad plot


def _is_suspicious(status: int | None) -> bool:
    """4xx/5xx only - a real Jellyfin session alone routinely fires 20+
    requests within a few seconds (progress pings, thumbnails, playback
    stats), so a request-volume threshold flagged completely normal single-
    user traffic as suspicious. Status is a much more direct signal for
    what this is actually meant to catch (scans, probing, broken/bruteforce
    auth attempts) and doesn't get noisier just because someone is
    legitimately using the app a lot."""
    return status is not None and status >= 400


def _record(ip: str, domain: str, status: int | None, source: str) -> None:
    if _is_private_ip(ip):
        return
    lat, lon, city, country = _geolocate(ip)
    event = TrafficEvent(
        id=uuid.uuid4().hex,
        ts=time.time(),
        ip=ip,
        lat=lat,
        lon=lon,
        city=city,
        country=country,
        domain=domain,
        status=status,
        source=source,
        suspicious=_is_suspicious(status),
    )
    _state.events.append(event)
    logger.debug(
        "traffic event: %s (%s) -> %s status=%s suspicious=%s", ip, city, source, status, event.suspicious
    )


class _RemoteTail:
    """One persistent SSH connection to one host, reconnected on failure."""

    def __init__(self, ip: str, port: int, username: str, key_path: Path):
        self.ip = ip
        self.port = port
        self.username = username
        self.key_path = key_path
        self._conn: asyncssh.SSHClientConnection | None = None

    async def _ensure_connected(self) -> asyncssh.SSHClientConnection:
        if self._conn is not None:
            return self._conn
        client_key = asyncssh.import_private_key(self.key_path.read_text())
        self._conn = await asyncssh.connect(
            host=self.ip,
            port=self.port,
            username=self.username,
            client_keys=[client_key],
            known_hosts=None,
            connect_timeout=8,
        )
        return self._conn

    async def run(self, command: str) -> str:
        conn = await self._ensure_connected()
        try:
            result = await conn.run(command, check=False, timeout=10)
        except (OSError, asyncssh.Error, asyncio.TimeoutError):
            self._conn = None
            raise
        return result.stdout or ""


async def _poll_caddy(tail: _RemoteTail, offsets: dict[str, int], _tick: int) -> None:
    path = shlex.quote(get_settings().traffic_caddy_log)
    offset = offsets.get(path, None)
    if offset is None:
        size_out = await tail.run(f"sudo -n stat -c%s {path} 2>/dev/null || echo 0")
        offsets[path] = int(size_out.strip() or 0)
        return

    size_out = await tail.run(
        f"sz=$(sudo -n stat -c%s {path} 2>/dev/null || echo 0); "
        f"[ \"$sz\" -lt {offset} ] && off=0 || off={offset}; "
        f"sudo -n tail -c +$((off+1)) {path} 2>/dev/null; "
        f"echo ---OPS-EOF-$sz---"
    )
    content, _, _marker = size_out.rpartition("---OPS-EOF-")
    new_size = int(_marker.rstrip("-\n") or offset)
    offsets[path] = new_size

    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        request = record.get("request", {})
        ip = request.get("client_ip") or request.get("remote_ip")
        domain = request.get("host")
        status = record.get("status")
        if ip and domain:
            _record(ip, domain, status, "edge-host")


async def _poll_npm(tail: _RemoteTail, offsets: dict[str, int], tick: int) -> None:
    log_dir = shlex.quote(get_settings().traffic_npm_log_dir)
    if tick % NPM_REGLOB_EVERY_N_TICKS == 0:
        listing = await tail.run(f"ls -1 {log_dir}/proxy-host-*_access.log 2>/dev/null")
        for path in listing.splitlines():
            path = path.strip()
            if path and path not in offsets:
                size_out = await tail.run(f"stat -c%s {path} 2>/dev/null || echo 0")
                offsets[path] = int(size_out.strip() or 0)

    for path, offset in list(offsets.items()):
        out = await tail.run(
            f"sz=$(stat -c%s {path} 2>/dev/null || echo 0); "
            f"[ \"$sz\" -lt {offset} ] && off=0 || off={offset}; "
            f"tail -c +$((off+1)) {path} 2>/dev/null; "
            f"echo ---OPS-EOF-$sz---"
        )
        content, _, marker = out.rpartition("---OPS-EOF-")
        offsets[path] = int(marker.rstrip("-\n") or offset)

        for line in content.splitlines():
            match = _NPM_LOG_RE.match(line)
            if not match:
                continue
            ip = match.group("ip").strip()
            domain = match.group("domain")
            status = int(match.group("status"))
            _record(ip, domain, status, "home")


async def _resolve_home_dest(tail: _RemoteTail) -> None:
    """Geolocates the home network's own public IP (via a domain that only
    resolves to it) so the map has somewhere to draw arcs landing at "home" -
    reuses the same local GeoIP database rather than asking the user for
    coordinates, so it's exactly as precise as what an external visitor's
    own geolocation would show for this network, no more."""
    try:
        out = await tail.run("curl -s --max-time 5 https://ipinfo.io/ip || true")
        ip = out.strip()
        if not ip:
            return
        lat, lon, city, country = _geolocate(ip)
        if lat is not None and lon is not None:
            _state.dest_points["home"] = {"lat": lat, "lon": lon, "city": city, "country": country}
    except (OSError, asyncssh.Error, asyncio.TimeoutError):
        logger.warning("could not resolve home's public IP for the Traffic Map destination pin")


async def _publish_snapshot() -> None:
    """Lets worker_ai's Network Agent (a separate process/container with no
    access to this module's in-memory state) read a recent view of it - see
    worker_ai/ai/tools/network_tools.py. Best-effort only: this is a
    visualization/AI-tool feature, never allowed to affect the poll loop
    that calls it."""
    try:
        redis_client = get_redis_client()
        payload = json.dumps(
            {
                "events": [asdict(e) for e in list(_state.events)[-_SNAPSHOT_EVENT_COUNT:]],
                "destinations": _state.dest_points,
            }
        )
        await redis_client.set(REDIS_SNAPSHOT_KEY, payload, ex=REDIS_SNAPSHOT_TTL)
    except Exception:
        logger.debug("traffic_watch: failed to publish Redis snapshot", exc_info=True)


async def _source_loop(name: str, tail: _RemoteTail, poll_fn) -> None:
    offsets: dict[str, int] = {}
    tick = 0
    while True:
        try:
            await poll_fn(tail, offsets, tick)
        except (OSError, asyncssh.Error, asyncio.TimeoutError) as exc:
            logger.warning("traffic_watch: %s poll failed (%s), reconnecting in %ss", name, exc, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)
            continue
        except Exception:
            logger.exception("traffic_watch: unexpected error polling %s", name)
        await _publish_snapshot()
        tick += 1
        await asyncio.sleep(POLL_INTERVAL)


async def _load_host_connection(hostname: str) -> _RemoteTail | None:
    async with async_session_factory() as db:
        result = await db.execute(
            select(Host).where(Host.hostname == hostname).options(selectinload(Host.credential))
        )
        host = result.scalar_one_or_none()
    if host is None or host.credential is None:
        logger.warning("traffic_watch: host %s or its credential is not configured - skipping", hostname)
        return None
    try:
        key_path = _resolve_secret(host.credential.secret_path)
    except ValueError:
        logger.exception("traffic_watch: bad credential secret_path for %s - skipping", hostname)
        return None
    if not key_path.exists():
        logger.warning("traffic_watch: credential file missing for %s - skipping", hostname)
        return None
    return _RemoteTail(host.ip_address, host.ssh_port, host.ssh_user, key_path)


async def start_traffic_watch() -> None:
    """Fire-and-forget background tasks - call once from app startup. Never
    raises: this is a visualization feature, not core functionality, and
    must not be able to take ops-api's own startup down with it."""
    try:
        await _start_traffic_watch_unsafe()
    except Exception:
        logger.exception("traffic_watch: failed to start - Traffic Map will show no data")


async def _start_traffic_watch_unsafe() -> None:
    settings = get_settings()
    if not settings.traffic_caddy_host and not settings.traffic_npm_host:
        return
    vps_tail = await _load_host_connection(settings.traffic_caddy_host) if settings.traffic_caddy_host else None
    npm_tail = await _load_host_connection(settings.traffic_npm_host) if settings.traffic_npm_host else None

    async with async_session_factory() as db:
        result = await db.execute(select(Host).where(Host.hostname == settings.traffic_caddy_host))
        vps_host = result.scalar_one_or_none()
    if vps_host is not None and vps_host.latitude is not None and vps_host.longitude is not None:
        _state.dest_points["edge-host"] = {
            "lat": vps_host.latitude,
            "lon": vps_host.longitude,
            "city": None,
            "country": None,
        }

    if vps_tail is not None:
        asyncio.create_task(_source_loop("edge-host", vps_tail, _poll_caddy))

    if npm_tail is not None:
        asyncio.create_task(_source_loop("home", npm_tail, _poll_npm))
        asyncio.create_task(_home_dest_refresh_loop(npm_tail))


async def _home_dest_refresh_loop(tail: _RemoteTail) -> None:
    while True:
        await _resolve_home_dest(tail)
        await asyncio.sleep(HOME_DEST_REFRESH_S)


def get_recent_events(since: float) -> list[dict]:
    return [asdict(e) for e in _state.events if e.ts > since]


def get_dest_points() -> dict:
    return dict(_state.dest_points)
