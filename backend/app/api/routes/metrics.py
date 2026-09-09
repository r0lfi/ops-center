import time

import httpx
from fastapi import APIRouter, Query

router = APIRouter()

PROMETHEUS_URL = "http://prometheus:9090"

# Same expressions the Grafana Linux Host Overview / Filesystem / Network
# dashboards already use (monitoring/grafana/provisioning/dashboard-json/) -
# `instance` is relabeled from the file_sd `hostname` label in
# prometheus.yml, so it's already the readable hostname, not ip:port.
_QUERIES = {
    "cpu": '100 - (avg by (instance) (irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    "memory": "(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100",
    # Root filesystem only - one number per host, matching the CPU/memory
    # granularity, rather than one series per mountpoint.
    "disk": (
        '(1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay", mountpoint="/"} '
        '/ node_filesystem_size_bytes{fstype!~"tmpfs|overlay", mountpoint="/"})) * 100'
    ),
    "network_rx": 'sum by (instance) (irate(node_network_receive_bytes_total{device!="lo"}[5m]))',
    "network_tx": 'sum by (instance) (irate(node_network_transmit_bytes_total{device!="lo"}[5m]))',
}


async def _range_query(client: httpx.AsyncClient, expr: str, start: float, end: float, step: str) -> dict:
    resp = await client.get(
        f"{PROMETHEUS_URL}/api/v1/query_range",
        params={"query": expr, "start": start, "end": end, "step": step},
    )
    resp.raise_for_status()
    return resp.json()


async def _instant_query(client: httpx.AsyncClient, expr: str) -> dict:
    resp = await client.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": expr})
    resp.raise_for_status()
    return resp.json()


@router.get("/metrics/hosts")
async def host_metrics(
    minutes: int = Query(default=60, ge=5, le=1440), instance: str | None = None
) -> dict:
    """
    Per-host CPU/memory/disk/network utilization over time, straight from
    Prometheus - powers the native Fleet Metrics charts on the Monitoring
    page (an alternative to the embedded Grafana dashboards below them).
    `instance` optionally narrows the response to a single host (used by
    the per-host detail view and the wallboard's focused mode) - filtered
    after the fact rather than injected into the PromQL, since these
    expressions' shapes vary too much to safely string-splice a label
    matcher into all of them. At homelab scale (a handful of hosts) the
    extra query cost of always pulling every host is negligible. Degrades
    gracefully like /api/logs: available=false rather than raising if
    Prometheus is unreachable.
    """
    end = time.time()
    start = end - minutes * 60
    step = "60s" if minutes <= 180 else "300s"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            results: dict[str, list[dict]] = {}
            for metric, expr in _QUERIES.items():
                data = await _range_query(client, expr, start, end, step)
                series = []
                for result in data.get("data", {}).get("result", []):
                    inst = result.get("metric", {}).get("instance", "unknown")
                    if instance and inst != instance:
                        continue
                    points = [[float(ts), float(v)] for ts, v in result.get("values", [])]
                    series.append({"instance": inst, "points": points})
                results[metric] = series
    except (httpx.HTTPError, ValueError):
        return {"available": False, "cpu": [], "memory": [], "disk": [], "network_rx": [], "network_tx": []}

    return {"available": True, **results}


@router.get("/metrics/services")
async def service_status() -> dict:
    """
    Current up/down + latency for the self-hosted apps probed by the
    `blackbox_apps` Prometheus job (see monitoring/prometheus/prometheus.yml)
    - Jellyfin, Sonarr, etc. Instant query, not a range - this is a status
    board, not a trend chart. Degrades gracefully like the other metrics
    routes.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            success_data = await _instant_query(client, 'probe_success{job="blackbox_apps"}')
            duration_data = await _instant_query(client, 'probe_duration_seconds{job="blackbox_apps"}')
    except (httpx.HTTPError, ValueError):
        return {"available": False, "services": []}

    durations = {
        r.get("metric", {}).get("service", "unknown"): float(r["value"][1])
        for r in duration_data.get("data", {}).get("result", [])
    }
    services = [
        {
            "service": r.get("metric", {}).get("service", "unknown"),
            "up": r["value"][1] == "1",
            "latency_ms": round(durations[r.get("metric", {}).get("service", "unknown")] * 1000)
            if r.get("metric", {}).get("service") in durations
            else None,
        }
        for r in success_data.get("data", {}).get("result", [])
    ]
    services.sort(key=lambda s: s["service"])

    return {"available": True, "services": services}
