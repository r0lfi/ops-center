import httpx
from fastapi import APIRouter, Query, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db
from app.api.deps import require_role
from app.services.monitoring import inventory, range_batch, bind_hosts, HOST_QUERIES, resolve_host, PROMETHEUS_URL

router = APIRouter()

# Legacy response keys remain stable for Wallboard and reviewed MCP clients.
_METRICS = ("cpu", "memory", "disk", "network_rx", "network_tx")


async def _instant_query(client: httpx.AsyncClient, expr: str) -> dict:
    resp = await client.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": expr})
    resp.raise_for_status()
    return resp.json()


@router.get("/metrics/hosts", dependencies=[Depends(require_role("viewer"))])
async def host_metrics(
    minutes: int = Query(default=60, ge=5, le=10080), instance: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Compatibility response for Wallboard; inventory bound, no unscoped targets."""
    hosts, _ = await inventory(db)
    if instance is not None:
        selected = await resolve_host(db, hostname=instance)
        hosts = [h for h in hosts if h.id == selected.id]
    batch = await range_batch(HOST_QUERIES, minutes)
    bound = bind_hosts(batch, hosts)
    result = {key: [] for key in _METRICS}
    for host in hosts:
        for key in result:
            series = bound[str(host.id)].get(key, [])
            if key == "disk":
                series = [s for s in series if s["labels"].get("mountpoint") == "/"]
            if key.startswith("network_") and series:
                totals = {}
                for series_item in series:
                    for timestamp, value in series_item["points"]:
                        totals[timestamp] = totals.get(timestamp, 0) + value
                series = [{"points": sorted(totals.items())}]
            result[key].extend({"instance": host.hostname, "points": s["points"]} for s in series)
    return {"available": not batch["errors"], **result}


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
