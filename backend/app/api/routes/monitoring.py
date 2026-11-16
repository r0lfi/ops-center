"""Native read-only monitoring composition of existing sources."""
import asyncio
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.api.routes.alerts import list_alerts
from app.api.routes.containers import _docker_container_stats, _list_docker_events
from app.db.session import get_db
from app.models.monitoring import MonitoringCheck
from app.services.monitoring import (
    HOST_QUERIES, DETAIL_QUERIES, CONTAINER_QUERIES, inventory, range_batch,
    bind_hosts, bind_containers, host_for_labels, container_record, resolve_container, container_metrics_state,
)

router = APIRouter(dependencies=[Depends(require_role("viewer"))])


@router.get("/monitoring/fleet")
async def fleet(
    minutes: int = Query(60, ge=15, le=10080),
    end: float | None = Query(None, gt=0),
    host_id: UUID | None = None,
    db: AsyncSession = Depends(get_db),
):
    hosts, containers = await inventory(db)
    if host_id is not None:
        from fastapi import HTTPException
        if not any(h.id == host_id for h in hosts):
            raise HTTPException(404, "Host not found in authorized inventory")
    queries = {**HOST_QUERIES, **(DETAIL_QUERIES if host_id else {})}
    cqueries = {k: v for k, v in CONTAINER_QUERIES.items() if k in ("up", "cpu", "memory", "network_rx", "network_tx", "last_sample")}
    host_batch, container_batch, alerts = await asyncio.gather(
        range_batch(queries, minutes, end), range_batch(cqueries, minutes, end), list_alerts())
    hmetrics = bind_hosts(host_batch, hosts)
    cmetrics = bind_containers(container_batch, hosts, containers)
    checks = (await db.execute(select(MonitoringCheck))).scalars().all() if host_id else []
    result = []
    for host in hosts:
        if host_id is not None and host.id != host_id:
            continue
        active = []
        for alert in alerts.get("alerts", []):
            mapped = host_for_labels(alert.get("labels", {}), hosts)
            if mapped is None or mapped.id != host.id or alert.get("status", {}).get("state") != "active":
                continue
            active.append({"name": alert.get("labels", {}).get("alertname", "Alert"),
                           "severity": alert.get("labels", {}).get("severity", "unknown"),
                           "summary": alert.get("annotations", {}).get("summary", ""),
                           "starts_at": alert.get("startsAt")})
        metrics = hmetrics[str(host.id)]
        last = max((p[1] for s in metrics.get("last_sample", []) for p in s["points"]), default=None)
        up = [s["points"][-1] for s in metrics.get("up", []) if s["points"]]
        source_failed = "up" in host_batch["errors"]
        now = end if end is not None else datetime.now(timezone.utc).timestamp()
        if not host.monitoring_enabled:
            status = "Not configured"
        elif source_failed:
            status = "Source unavailable"
        elif not up:
            status = "No data"
        elif now - max(p[0] for p in up) > 180:
            status = "Stale"
        elif any(p[1] == 0 for p in up):
            status = "Scrape failed"
        elif last is None:
            status = "No data"
        elif now - last > 180:
            status = "Stale"
        else:
            status = "Monitored"
        result.append({"id": str(host.id), "hostname": host.hostname, "ip_address": host.ip_address,
                       "operating_system": host.operating_system, "os_version": host.os_version,
                       "monitoring_enabled": host.monitoring_enabled, "log_collection_enabled": host.log_collection_enabled,
                       "is_docker_host": host.is_docker_host, "container_inventory_at": host.container_inventory_at,
                       "status": status, "last_sample": last, "metrics": metrics,
                       "alerts": active if alerts["available"] else None,
                       "services": [{"id": str(c.id), "target": c.target, "enabled": c.enabled,
                                     "check_type": c.check_type} for c in checks if c.host_id == host.id]})
    host_by_name = {h.hostname: h for h in hosts}
    records = [{**container_record(c, host_by_name[c.hostname], historical=end is not None), "metrics": cmetrics[str(c.id)],
                "metrics_state": container_metrics_state(host_by_name[c.hostname], cmetrics[str(c.id)], container_batch, end)}
               for c in containers if host_id is None or host_by_name[c.hostname].id == host_id]
    return {"hosts": result, "containers": records, "errors": host_batch["errors"],
            "container_errors": container_batch["errors"], "alerts_available": alerts["available"]}


@router.get("/monitoring/containers/{container_id}")
async def container_detail(container_id: UUID, minutes: int = Query(60, ge=15, le=10080),
                           end: float | None = Query(None, gt=0), db: AsyncSession = Depends(get_db)):
    host, container = await resolve_container(db, container_id)
    batch = await range_batch(CONTAINER_QUERIES, minutes, end)
    metrics = bind_containers(batch, [host], [container])[str(container.id)]
    return {**container_record(container, host, historical=end is not None), "metrics": metrics, "errors": batch["errors"],
            "metrics_state": container_metrics_state(host, metrics, batch, end)}


@router.get("/monitoring/containers/{container_id}/stats")
async def container_stats(container_id: UUID, db: AsyncSession = Depends(get_db)):
    from fastapi import HTTPException
    host, container = await resolve_container(db, container_id)
    if not container.runtime_id:
        raise HTTPException(409, "Runtime identity not collected yet")
    # Existing Docker stats path; exact runtime ID refuses recreated names.
    snapshot = await _docker_container_stats(host.hostname, container.runtime_id, db)
    return {**snapshot, "measured_at": datetime.now(timezone.utc).isoformat()}


@router.get("/monitoring/containers/{container_id}/events")
async def container_events(container_id: UUID, minutes: int = Query(60, ge=15, le=10080),
                           end: float | None = Query(None, gt=0), db: AsyncSession = Depends(get_db)):
    host, container = await resolve_container(db, container_id)
    if not container.runtime_id:
        return {"state": "not_configured", "events": []}
    now = datetime.now(timezone.utc).timestamp()
    stop = min(end, now) if end is not None else now
    events = await _list_docker_events(host.hostname, "container", 200, db,
                                     container_id=container.runtime_id, since=stop - minutes * 60, until=stop)
    return {"state": "available", "events": [{"action": e.action.split(":", 1)[0],
            "occurred_at": e.occurred_at, "actor_id": e.actor_id} for e in events]}
