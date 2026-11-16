"""Inventory-bound read-only monitoring, shared by native and legacy views."""
import asyncio
import math
import re
import time
from collections import OrderedDict
from uuid import UUID

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from app.core.config import get_settings
from app.models.container import Container
from app.models.host import Host

PROMETHEUS_URL = get_settings().prometheus_query_url.rstrip("/")
FS = 'fstype!~"tmpfs|overlay|squashfs|iso9660|nsfs|proc|sysfs",mountpoint!~"/run.*|/var/lib/docker.*|/var/lib/containers.*"'
HOST_QUERIES = {
    "cpu": '100 - avg by (instance,host_id) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
    "memory": '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
    "disk": f'(1 - node_filesystem_avail_bytes{{{FS}}} / node_filesystem_size_bytes{{{FS}}}) * 100',
    "network_rx": 'rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m])',
    "network_tx": 'rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m])',
    "up": 'up{job="node_exporter"}',
    "last_sample": 'timestamp(node_memory_MemTotal_bytes)',
    "uptime": 'time() - node_boot_time_seconds',
}
DETAIL_QUERIES = {
    "load1": 'node_load1', "load5": 'node_load5', "load15": 'node_load15',
    "memory_used": 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes',
    "memory_total": 'node_memory_MemTotal_bytes',
    "swap_used": 'node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes',
    "swap_total": 'node_memory_SwapTotal_bytes',
    "disk_bytes": f'node_filesystem_size_bytes{{{FS}}} - node_filesystem_avail_bytes{{{FS}}}',
    "disk_total": f'node_filesystem_size_bytes{{{FS}}}',
    "inodes": f'(1 - node_filesystem_files_free{{{FS}}} / node_filesystem_files{{{FS}}}) * 100',
    "disk_read": 'rate(node_disk_read_bytes_total{device!~"loop.*|ram.*"}[5m])',
    "disk_write": 'rate(node_disk_written_bytes_total{device!~"loop.*|ram.*"}[5m])',
    "uname": 'node_uname_info',
    "services": 'ops_center_monitored_unit_active',
    "service_sample": 'timestamp(ops_center_monitored_unit_active)',
}
CONTAINER_QUERIES = {
    "up": 'up{job="cadvisor"}',
    "cpu": 'sum by (instance,host_id,id) (rate(container_cpu_usage_seconds_total{id!="/"}[5m])) * 100',
    "memory": 'container_memory_working_set_bytes{id!="/"}',
    "memory_limit": 'container_spec_memory_limit_bytes{id!="/"}',
    "network_rx": 'rate(container_network_receive_bytes_total{id!="/",interface!="lo"}[5m])',
    "network_tx": 'rate(container_network_transmit_bytes_total{id!="/",interface!="lo"}[5m])',
    "disk_read": 'rate(container_fs_reads_bytes_total{id!="/"}[5m])',
    "disk_write": 'rate(container_fs_writes_bytes_total{id!="/"}[5m])',
    "last_sample": 'timestamp(container_memory_working_set_bytes{id!="/"})',
}
# Bounded source cache; authorization/identity filtering ALWAYS happens after lookup.
_CACHE: OrderedDict = OrderedDict()
_INFLIGHT: dict = {}
_QUERY_LIMIT = asyncio.Semaphore(4)


async def range_batch(queries: dict, minutes: int, end: float | None = None) -> dict:
    now = time.time()
    if end is not None:
        end = min(end, now)
    stop = end if end is not None else math.floor(now / 15) * 15
    key = (tuple(queries.items()), minutes, stop)
    cached = _CACHE.get(key)
    if cached and now - cached[0] < 30:
        return cached[1]
    if key in _INFLIGHT:
        return await asyncio.shield(_INFLIGHT[key])
    if len(_INFLIGHT) >= 8:
        return {"series": {}, "errors": {n: "Metrics query capacity reached; retry shortly" for n in queries}}

    async def fetch():
        step = max(15, math.ceil(minutes * 60 / 480))
        async with httpx.AsyncClient(timeout=8) as client:
            async def query(name, expr):
                async with _QUERY_LIMIT:
                    try:
                        r = await client.get(f"{PROMETHEUS_URL}/api/v1/query_range", params={
                            "query": expr, "start": stop - minutes * 60, "end": stop, "step": step})
                        r.raise_for_status()
                        data = r.json()
                        if data.get("status") != "success":
                            raise ValueError("query failed")
                        return name, data.get("data", {}).get("result", []), None
                    except (httpx.HTTPError, ValueError):
                        return name, [], "Metrics source unavailable or query failed"
            async def bounded(name, expr):
                try:
                    return await asyncio.wait_for(query(name, expr), timeout=25)
                except TimeoutError:
                    return name, [], "Metrics query timed out"
            rows = await asyncio.gather(*(bounded(n, e) for n, e in queries.items()))
        result = {"series": {n: r for n, r, _ in rows}, "errors": {n: e for n, _, e in rows if e}}
        _CACHE[key] = (time.time(), result)
        while len(_CACHE) > 32:
            _CACHE.popitem(last=False)
        return result

    task = asyncio.create_task(fetch())
    _INFLIGHT[key] = task
    try:
        return await asyncio.shield(task)
    finally:
        # task may outlive a disconnected request; do not allow duplicate work.
        task.add_done_callback(lambda _: _INFLIGHT.pop(key, None))


def points(raw: dict) -> list:
    result = []
    for point in raw.get("values", []):
        try:
            timestamp, value = map(float, point)
        except (ValueError, TypeError):
            continue
        if math.isfinite(timestamp) and math.isfinite(value):
            result.append([timestamp, value])
    return result


def host_for_labels(labels: dict, hosts: list[Host]) -> Host | None:
    # An explicit ID never falls back to a name, even if the ID is unknown.
    if labels.get("host_id"):
        return next((h for h in hosts if str(h.id) == labels["host_id"]), None)
    name = labels.get("hostname") or labels.get("host") or labels.get("instance")
    matches = [h for h in hosts if h.hostname == name]
    return matches[0] if len(matches) == 1 else None


def bind_hosts(batch: dict, hosts: list[Host]) -> dict:
    result = {str(h.id): {} for h in hosts}
    for metric, series in batch["series"].items():
        for raw in series:
            host = host_for_labels(raw.get("metric", {}), hosts)
            if host is None or not host.monitoring_enabled:
                continue
            values = points(raw)
            if values:
                result[str(host.id)].setdefault(metric, []).append({"labels": raw.get("metric", {}), "points": values})
    return result


def bind_containers(batch: dict, hosts: list[Host], containers: list[Container]) -> dict:
    mappings = get_settings().monitoring_container_targets
    host_by_id = {str(h.id): h for h in hosts if h.is_docker_host}
    by_identity = {(str(h.id), c.runtime_id): c for h in hosts for c in containers
                   if c.hostname == h.hostname and c.runtime_id and h.is_docker_host}
    result = {str(c.id): {} for c in containers}
    for metric, series in batch["series"].items():
        for raw in series:
            labels = raw.get("metric", {})
            host_id = labels.get("host_id") or mappings.get(labels.get("instance", ""))
            if host_id not in host_by_id:
                continue
            match = re.search(r'(?:^|/|docker-)([a-f0-9]{64})(?:\.scope)?$', labels.get("id", ""))
            if not match:
                continue
            container = by_identity.get((host_id, match[1]))
            if container is None:
                continue
            values = points(raw)
            if values:
                result[str(container.id)].setdefault(metric, []).append({"labels": labels, "points": values})
    return result


def container_metrics_state(host: Host, metrics: dict, batch: dict, end: float | None = None) -> str:
    if batch["errors"]:
        return "Partial data" if metrics else "Source unavailable"
    host_id = str(host.id)
    configured = host_id in get_settings().monitoring_container_targets.values() or any(
        raw.get("metric", {}).get("host_id") == host_id
        for rows in batch["series"].values() for raw in rows)
    if not configured:
        return "Not configured"
    if not metrics:
        return "No data"
    last = max((p[1] for s in metrics.get("last_sample", []) for p in s["points"]), default=None)
    if last is not None and (end if end is not None else time.time()) - last > 180:
        return "Stale"
    return "Available"


async def inventory(db):
    # Web RBAC grants Viewer and above fleet read access, like Hosts/Containers.
    # No per-host web ACL exists; do not invent a weaker alternative to it.
    hosts = list((await db.execute(select(Host).order_by(Host.hostname))).scalars().all())
    containers = list((await db.execute(select(Container).order_by(Container.hostname, Container.name))).scalars().all())
    names = {h.hostname for h in hosts if h.is_docker_host and sum(other.hostname == h.hostname for other in hosts) == 1}
    return hosts, [c for c in containers if c.hostname in names]


async def resolve_host(db, host_id: UUID | None = None, hostname: str | None = None) -> Host:
    if host_id is not None:
        host = await db.get(Host, host_id)
    else:
        matches = list((await db.execute(select(Host).where(Host.hostname == hostname))).scalars().all())
        if len(matches) > 1:
            raise HTTPException(409, "Ambiguous host name; use the inventory host ID")
        host = matches[0] if matches else None
    if host is None:
        raise HTTPException(404, "Host not found in authorized inventory")
    if hostname is not None and host.hostname != hostname:
        raise HTTPException(404, "Host identity does not match")
    return host


async def resolve_container(db, container_id: UUID, host_id: UUID | None = None):
    container = await db.get(Container, container_id)
    if container is None:
        raise HTTPException(404, "Container not found in authorized inventory")
    host = await resolve_host(db, host_id, container.hostname)
    if not host.is_docker_host:
        raise HTTPException(404, "Container host is not configured")
    return host, container


def container_record(c, host, historical=False):
    metadata = dict(c.monitoring_metadata or {})
    if historical:
        metadata.pop("runtime_stats", None)
    return {"id": str(c.id), "host_id": str(host.id), "hostname": host.hostname,
            "runtime_id": c.runtime_id, "name": c.name, "image": c.image,
            "status": c.status, "health": c.health, "restart_count": c.restart_count,
            "last_seen": c.last_seen, "metadata": metadata}
