import time

import httpx
from fastapi import APIRouter, Query

router = APIRouter()

LOKI_URL = "http://loki:3100"


def _build_logql(host: str | None, service: str | None) -> str:
    labels = []
    if host:
        labels.append(f'host="{host}"')
    if service:
        labels.append(f'unit="{service}"')
    if not labels:
        # Loki requires at least one label matcher; this one matches every
        # stream Alloy pushes (see install-alloy.yml's loki.write block name).
        return '{job=~".+"}'
    return "{" + ", ".join(labels) + "}"


@router.get("/logs")
async def query_logs(
    host: str | None = None,
    service: str | None = None,
    minutes: int = Query(default=60, ge=1, le=10080),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict:
    """
    Proxies a Loki range query. Degrades gracefully - if Loki is
    unavailable, returns available=false rather than raising, matching the
    "monitoring unavailable" failure-handling policy used elsewhere.
    """
    query = _build_logql(host, service)
    end_ns = int(time.time() * 1_000_000_000)
    start_ns = end_ns - minutes * 60 * 1_000_000_000

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{LOKI_URL}/loki/api/v1/query_range",
                params={"query": query, "start": start_ns, "end": end_ns, "limit": limit, "direction": "backward"},
            )
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError):
        return {"available": False, "lines": []}

    lines = []
    for stream in data.get("data", {}).get("result", []):
        labels = stream.get("stream", {})
        for ts, line in stream.get("values", []):
            lines.append({"timestamp": ts, "labels": labels, "line": line})
    lines.sort(key=lambda entry: entry["timestamp"], reverse=True)

    return {"available": True, "lines": lines[:limit]}
