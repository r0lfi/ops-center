"""Shared Loki/Docker log API. All contextual queries fail closed on identity."""
import base64
import json
import re
import time
from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import get_db
from app.services.monitoring import inventory, resolve_host, resolve_container

router = APIRouter(dependencies=[Depends(require_role("viewer"))])
LOKI_URL = get_settings().loki_url.rstrip("/").removesuffix("/ready")
NS = 1_000_000_000


def _build_logql(host: str | None, service: str | None) -> str:
    labels = []
    if host:
        labels.append('host=' + json.dumps(host))
    if service:
        labels.append('unit=' + json.dumps(service))
    return "{" + ", ".join(labels or ['job=~".+"']) + "}"


def _cursor(timestamp: int, skip: int = 0) -> str:
    return base64.urlsafe_b64encode(json.dumps([timestamp, skip]).encode()).decode()


def _decode_cursor(cursor: str | None, start: int, end: int):
    if not cursor:
        return end, 0
    try:
        timestamp, skip = json.loads(base64.urlsafe_b64decode(cursor))
        if type(timestamp) is not int or type(skip) is not int or not start <= timestamp <= end or not 0 <= skip <= 500:
            raise ValueError()
        return timestamp, skip
    except (ValueError, TypeError, json.JSONDecodeError):
        raise HTTPException(422, "Invalid log cursor or cursor outside selected time window")


def _rfc3339(ns: int):
    seconds, fraction = divmod(ns, NS)
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + f'.{fraction:09d}Z'


def _docker_line(raw: str, host: str, runtime_id: str):
    match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z\s(.*)$', raw, re.S)
    if not match:
        return None
    seconds = int(datetime.fromisoformat(match[1]).replace(tzinfo=timezone.utc).timestamp())
    ns = seconds * NS + int((match[2] or '').ljust(9, '0') or 0)
    return {"timestamp": str(ns), "labels": {"host": host, "container_id": runtime_id}, "line": match[3][:65536]}


@router.get("/logs")
async def query_logs(
    host: str | None = Query(None, max_length=255),
    host_id: UUID | None = None,
    container_id: UUID | None = None,
    service: str | None = Query(None, max_length=255),
    search: str = Query("", max_length=500),
    level: str | None = Query(None, max_length=30),
    minutes: int = Query(60, ge=1, le=10080),
    limit: int = Query(200, ge=1, le=500),
    end: float | None = Query(None, gt=0),
    cursor: str | None = Query(None, max_length=200),
    db: AsyncSession = Depends(get_db),
) -> dict:
    stop = min(end, time.time()) if end is not None else time.time()
    end_ns = int(stop * NS)
    start_ns = end_ns - minutes * 60 * NS
    before, skip = _decode_cursor(cursor, start_ns, end_ns)
    selected = None
    container = None
    if container_id is not None:
        selected, container = await resolve_container(db, container_id, host_id)
        if host is not None and selected.hostname != host:
            raise HTTPException(404, "Container host identity does not match")
    elif host_id is not None or host is not None:
        selected = await resolve_host(db, host_id, host)
    if selected is not None:
        # Existing Alloy labels use host names. Ambiguous names must fail closed.
        from sqlalchemy import select
        from app.models.host import Host
        matches = (await db.execute(select(Host).where(Host.hostname == selected.hostname))).scalars().all()
        if len(matches) != 1:
            raise HTTPException(409, "Log host identity is ambiguous; configure unique collector labels")
    base = {"available": True, "lines": [], "next_cursor": None, "start": start_ns, "end": end_ns,
            "levels": [], "source": "docker" if container else "loki"}
    if container is not None:
        if (container.monitoring_metadata or {}).get("log_driver") == "none":
            return {**base, "state": "not_configured", "message": "Docker logging is disabled for this container"}
        if not container.runtime_id:
            return {**base, "state": "not_configured", "message": "Runtime identity has not been collected yet"}
        if service or level:
            return {**base, "state": "unsupported", "message": "Docker logs do not provide reliable service or level labels"}
        from app.api.routes.containers import _docker_container_logs
        try:
            result = await _docker_container_logs(selected.hostname, container.runtime_id, limit + skip + 1, db,
                {"since": _rfc3339(start_ns), "until": _rfc3339(before + 1)})
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                raise
            return {**base, "available": False, "state": "unavailable", "message": "Container log source unavailable"}
        except Exception:
            return {**base, "available": False, "state": "unavailable", "message": "Container log source unavailable"}
        if not result.get("ok", False):
            if any("logging driver does not support reading" in str(line) for line in result.get("lines", [])):
                return {**base, "state": "not_configured", "message": "The configured Docker log driver does not support log reading"}
            return {**base, "available": False, "state": "unavailable", "message": "Runtime container or log driver unavailable"}
        lines = [line for raw in result.get("lines", []) if (line := _docker_line(raw, selected.hostname, container.runtime_id))]
        lines = [line for line in lines if start_ns <= int(line["timestamp"]) <= before]
    else:
        if selected is not None and not selected.log_collection_enabled:
            return {**base, "state": "not_configured", "message": "Log collection is disabled for this host"}
        if selected is None:
            hosts, _ = await inventory(db)
            names = [h.hostname for h in hosts if h.log_collection_enabled]
            if not names:
                return {**base, "state": "not_configured", "message": "No inventory hosts have log collection enabled"}
            regex = "|".join(re.escape(name) for name in names)
            query = '{host=~' + json.dumps(regex) + (',unit=' + json.dumps(service) if service else '') + '}'
        else:
            query = _build_logql(selected.hostname, service)
        if level:
            query = query[:-1] + ',level=' + json.dumps(level) + '}'
        if search:
            query += ' |= ' + json.dumps(search)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(f"{LOKI_URL}/loki/api/v1/query_range", params={
                    "query": query, "start": start_ns, "end": before,
                    "limit": limit + skip + 1, "direction": "backward"})
                response.raise_for_status()
                data = response.json()
                if data.get("status") != "success":
                    raise ValueError("Loki query failed")
        except (httpx.HTTPError, ValueError):
            return {**base, "available": False, "state": "unavailable", "message": "Loki is unavailable"}
        lines = [{"timestamp": ts, "labels": stream.get("stream", {}), "line": line[:65536]}
                 for stream in data.get("data", {}).get("result", []) for ts, line in stream.get("values", [])]
    # Deterministic ordering permits equal-timestamp cursor paging without dropping lines.
    lines.sort(key=lambda x: (int(x["timestamp"]), json.dumps(x["labels"], sort_keys=True), x["line"]), reverse=True)
    same_ts = [x for x in lines if int(x["timestamp"]) == before]
    lines = lines[min(skip, len(same_ts)):]
    page = lines[:limit]
    next_cursor = None
    if len(lines) > limit and page:
        oldest = int(page[-1]["timestamp"])
        consumed = sum(int(x["timestamp"]) == oldest for x in page) + (skip if oldest == before else 0)
        if consumed <= 500:
            next_cursor = _cursor(oldest, consumed)
    levels = sorted({x["labels"]["level"] for x in page if x["labels"].get("level")})
    if container and search:
        page = [x for x in page if search in x["line"]]
    return {**base, "state": "available", "lines": page, "next_cursor": next_cursor, "levels": levels,
            "message": "Equal-timestamp page limit reached" if len(lines) > limit and not next_cursor else None}
