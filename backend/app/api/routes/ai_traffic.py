"""AI Traffic Monitor API: read-only views of the AI layer's network activity.

Two kinds of callers:
* the passive host collector (ai_traffic_collector/), authenticated by the
  shared AI_TRAFFIC_INGEST_TOKEN, posts observations and picks up PCAP
  requests (`ingest_router`, no user session);
* the UI. Overview and coverage are visible to every signed-in user; event
  details, traces, the flow graph and exports need operator; PCAP captures
  and retention settings need admin.

Nothing here can change network configuration. Missing sources are reported
as missing coverage, never as zero events.
"""

import csv
import hashlib
import hmac
import io
import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import get_db

router = APIRouter()
ingest_router = APIRouter()

BLOCKED = ("firewall_block", "dns_block", "ai_access_control")
FAILED = ("remote_reject", "http_error", "dns_error", "connect_error", "timeout", "tls_error", "unknown")
OUTCOMES = ("ok",) + BLOCKED + FAILED
KINDS = ("http", "tcp", "udp", "dns", "access")
MAX_INGEST_EVENTS = 2000
MAX_CAPTURE_BYTES = 20 * 1024 * 1024
# A source that has not reported for this long is shown as down.
STALE_SECONDS = {"app": 120, "capture": 60}

EVENT_COLUMNS = (
    "id, ts, ended_at, duration_ms, ttfb_ms, node, kind, sources, trace_id, span_id, task_id, agent_slug, tool, "
    "provider, model, mcp_tool, container, pid, process, src_ip, src_port, dst_ip, dst_port, dst_host, protocol, "
    "method, path, status_code, bytes_sent, bytes_recv, outcome, reason, rule_id"
)
CSV_FIELDS = [c.strip() for c in EVENT_COLUMNS.split(",")]


def _row(mapping) -> dict:
    out = {}
    for key, value in dict(mapping).items():
        if isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, uuid.UUID):
            value = str(value)
        out[key] = value
    return out


def _window(window: str) -> timedelta:
    match = re.fullmatch(r"(\d{1,4})([mhd])", window)
    if not match:
        raise HTTPException(422, "window must look like 15m, 1h or 7d")
    amount, unit = int(match.group(1)), match.group(2)
    delta = {"m": timedelta(minutes=amount), "h": timedelta(hours=amount), "d": timedelta(days=amount)}[unit]
    if delta > timedelta(days=365) or delta <= timedelta(0):
        raise HTTPException(422, "window out of range")
    return delta


def _tsquery(q: str) -> str | None:
    words = re.findall(r"[A-Za-z0-9_.\-:/]+", q)[:8]
    words = [re.sub(r"[:/]", " ", w).strip() for w in words]
    terms = [t for w in words for t in w.split() if t]
    return " & ".join(f"{t}:*" for t in terms) if terms else None


class EventFilter(BaseModel):
    since: datetime | None = None
    until: datetime | None = None
    window: str | None = None
    agent: str | None = None
    model: str | None = None
    process: str | None = None
    container: str | None = None
    host: str | None = None
    ip: str | None = None
    port: int | None = None
    status: str | None = None
    kind: str | None = None
    node: str | None = None
    trace_id: str | None = None
    task_id: str | None = None
    tool: str | None = None
    q: str | None = None
    after_id: int | None = None


def _filters(params: EventFilter) -> tuple[str, dict]:
    clauses, values = [], {}
    if params.window:
        values["since"] = datetime.now(timezone.utc) - _window(params.window)
        clauses.append("ts >= :since")
    elif params.since:
        values["since"] = params.since
        clauses.append("ts >= :since")
    if params.until:
        values["until"] = params.until
        clauses.append("ts <= :until")
    for field in ("agent", "model", "process", "container", "node", "tool"):
        value = getattr(params, field)
        if value:
            column = {"agent": "agent_slug"}.get(field, field)
            if value == "-":
                clauses.append(f"{column} IS NULL")
            else:
                values[field] = value
                clauses.append(f"{column} = :{field}")
    if params.host:
        values["host"] = f"%{params.host.lower()}%"
        clauses.append("(lower(dst_host) LIKE :host OR dst_ip LIKE :host)")
    if params.ip:
        values["ip"] = params.ip
        clauses.append("(src_ip = :ip OR dst_ip = :ip)")
    if params.port is not None:
        values["port"] = params.port
        clauses.append("(dst_port = :port OR src_port = :port)")
    if params.status:
        if params.status == "blocked":
            clauses.append("outcome = ANY(:outcomes)")
            values["outcomes"] = list(BLOCKED)
        elif params.status == "failed":
            clauses.append("outcome = ANY(:outcomes)")
            values["outcomes"] = list(FAILED)
        elif params.status == "problem":
            clauses.append("outcome <> 'ok'")
        elif params.status in OUTCOMES:
            values["outcome"] = params.status
            clauses.append("outcome = :outcome")
        else:
            raise HTTPException(422, "unknown status")
    if params.kind:
        if params.kind not in KINDS:
            raise HTTPException(422, "unknown kind")
        values["kind"] = params.kind
        clauses.append("kind = :kind")
    if params.trace_id:
        values["trace_id"] = params.trace_id
        clauses.append("trace_id = :trace_id")
    if params.task_id:
        try:
            values["task_id"] = uuid.UUID(params.task_id)
        except ValueError:
            raise HTTPException(422, "task_id must be a UUID")
        clauses.append("task_id = :task_id")
    if params.q:
        query = _tsquery(params.q)
        if query:
            values["tsq"] = query
            values["qlike"] = f"%{params.q.lower()[:100]}%"
            clauses.append("(search @@ to_tsquery('simple', :tsq) OR lower(coalesce(dst_host,'')) LIKE :qlike "
                           "OR coalesce(dst_ip,'') LIKE :qlike OR lower(coalesce(reason,'')) LIKE :qlike)")
    if params.after_id is not None:
        values["after_id"] = params.after_id
        clauses.append("id > :after_id")
    return (" WHERE " + " AND ".join(clauses)) if clauses else "", values


def _event_filter(
    since: datetime | None = None, until: datetime | None = None, window: str | None = Query(None, max_length=8),
    agent: str | None = Query(None, max_length=50), model: str | None = Query(None, max_length=200),
    process: str | None = Query(None, max_length=200), container: str | None = Query(None, max_length=120),
    host: str | None = Query(None, max_length=253), ip: str | None = Query(None, max_length=45),
    port: int | None = Query(None, ge=0, le=65535), status: str | None = Query(None, max_length=24),
    kind: str | None = Query(None, max_length=10), node: str | None = Query(None, max_length=100),
    trace_id: str | None = Query(None, max_length=32), task_id: str | None = Query(None, max_length=36),
    tool: str | None = Query(None, max_length=100), q: str | None = Query(None, max_length=200),
    after_id: int | None = Query(None, ge=0),
) -> EventFilter:
    return EventFilter(since=since, until=until, window=window, agent=agent, model=model, process=process,
                       container=container, host=host, ip=ip, port=port, status=status, kind=kind, node=node,
                       trace_id=trace_id, task_id=task_id, tool=tool, q=q, after_id=after_id)


# --------------------------------------------------------------------------- collector

def collector_token(secret: str, node: str) -> str:
    """Each node's collector holds only HMAC-SHA256(secret, node): a leaked
    collector token cannot speak for another node or reveal the secret."""
    return hmac.new(secret.encode(), node.encode(), hashlib.sha256).hexdigest()


def _collector_node(request: Request) -> str:
    secret = get_settings().ai_traffic_ingest_token
    if not secret:
        raise HTTPException(503, "AI traffic ingest is not configured (AI_TRAFFIC_INGEST_TOKEN)")
    node = request.headers.get("x-ai-traffic-node", "")
    given = request.headers.get("x-ai-traffic-token", "")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", node) or not hmac.compare_digest(
            given.encode(), collector_token(secret, node).encode()):
        raise HTTPException(401, "invalid collector token for this node")
    return node


# What the passive capture can actually observe. Agent, trace, tool and model
# attribution comes only from the AI worker itself and is never accepted here.
CAPTURE_FIELDS = {
    "type", "obs_id", "ts", "ended_at", "duration_ms", "ttfb_ms", "kind", "container", "pid", "process",
    "src_ip", "src_port", "dst_ip", "dst_port", "dst_host", "protocol", "bytes_sent", "bytes_recv",
    "outcome", "reason", "detail",
}


@ingest_router.post("/ai-traffic/ingest")
async def ingest(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    node = _collector_node(request)
    raw = await request.body()
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, "batch too large")
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(422, "invalid JSON")
    events = body.get("events") or []
    if not isinstance(events, list) or len(events) > MAX_INGEST_EVENTS:
        raise HTTPException(422, f"events must be a list of at most {MAX_INGEST_EVENTS}")
    rows = []
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "event" or event.get("kind") not in KINDS:
            continue
        if not event.get("obs_id") or not isinstance(event.get("ts"), (int, float)):
            continue
        # The collector speaks only for the capture source of its own node.
        event = {**{k: v for k, v in event.items() if k in CAPTURE_FIELDS}, "source": "capture", "node": node}
        if not isinstance(event.get("detail"), dict):
            event.pop("detail", None)
        if event.get("outcome") not in OUTCOMES:
            event["outcome"] = "unknown"
        rows.append(event)
    merged = 0
    if rows:
        merged = (await db.execute(text("SELECT ai_traffic_ingest(CAST(:rows AS jsonb))"),
                                   {"rows": json.dumps(rows)})).scalar() or 0
    source = body.get("source") if isinstance(body.get("source"), dict) else {}
    await db.execute(text(
        "INSERT INTO ai_traffic_sources (name, kind, node, last_seen, last_event_at, stats) "
        "VALUES (:name, 'capture', :node, now(), CASE WHEN :has THEN now() END, CAST(:stats AS jsonb)) "
        "ON CONFLICT (name) DO UPDATE SET last_seen = now(), stats = EXCLUDED.stats, "
        "  last_event_at = CASE WHEN :has THEN now() ELSE ai_traffic_sources.last_event_at END"),
        {"name": f"capture:{node}", "node": node, "has": bool(rows), "stats": json.dumps(source)[:200_000]})
    await db.commit()
    return {"stored": len(rows), "merged": merged}


@ingest_router.get("/ai-traffic/collector/captures")
async def collector_captures(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    node = _collector_node(request)
    rows = (await db.execute(text(
        "UPDATE ai_traffic_captures SET status = 'running', started_at = now() WHERE id IN ("
        "  SELECT id FROM ai_traffic_captures WHERE node = :node AND status = 'pending' "
        "  ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED) "
        "RETURNING id, seconds, max_bytes"), {"node": node})).mappings().all()
    await db.commit()
    return {"captures": [_row(r) for r in rows]}


@ingest_router.post("/ai-traffic/collector/captures/{capture_id}")
async def collector_capture_result(capture_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    node = _collector_node(request)
    data = await request.body()
    if len(data) > MAX_CAPTURE_BYTES + 65536:
        raise HTTPException(413, "capture too large")
    status = request.headers.get("x-capture-status", "failed")
    packets = request.headers.get("x-capture-packets", "0")
    hours = (await db.execute(text("SELECT capture_retention_hours FROM ai_traffic_settings WHERE id = 1"))).scalar() or 24
    result = await db.execute(text(
        "UPDATE ai_traffic_captures SET status = :status, finished_at = now(), packets = :packets, size = :size, "
        "  data = :data, error = :error, expires_at = now() + make_interval(hours => :hours) "
        "WHERE id = :id AND node = :node AND status = 'running'"),
        {"status": "done" if status == "done" else "failed", "packets": int(packets) if packets.isdigit() else 0,
         "size": len(data), "data": data if status == "done" else None,
         "error": request.headers.get("x-capture-error", "")[:300] or None, "hours": int(hours),
         "id": capture_id, "node": node})
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(404, "no running capture with that id for this node")
    return {"ok": True}


# --------------------------------------------------------------------------- overview

async def _sources(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(text(
        "SELECT name, kind, node, last_seen, last_event_at, stats, "
        "       extract(epoch FROM now() - last_seen) AS age FROM ai_traffic_sources ORDER BY kind, node"))).mappings().all()
    out = []
    now = datetime.now(timezone.utc).timestamp()
    for r in rows:
        item = _row(r)
        stats = item.get("stats") or {}
        item["healthy"] = item["age"] is not None and item["age"] < STALE_SECONDS.get(item["kind"], 120)
        if item["kind"] == "app":
            procs = {pid: p for pid, p in (stats.get("processes") or {}).items()
                     if isinstance(p, dict) and now - float(p.get("ts") or 0) < 600}
            item["summary"] = {key: sum(int(p.get(key) or 0) for p in procs.values())
                               for key in ("emitted", "written", "dropped", "failed_batches", "queued", "merged")}
            item["summary"]["processes"] = len(procs)
            item["stats"] = {"processes": procs}
        else:
            item["summary"] = {
                "dropped": int(stats.get("dropped") or 0),
                "buffer": int(stats.get("buffer") or 0),
                "conntrack_overruns": int((stats.get("conntrack") or {}).get("overruns") or 0),
                "capture_kernel_drops": sum(int(i.get("kernel_dropped") or 0) for i in stats.get("interfaces") or [] if isinstance(i, dict)),
            }
        out.append(item)
    return out


def _coverage(sources: list[dict]) -> list[dict]:
    """What is and is not observed, stated explicitly."""
    nodes = sorted({s["node"] for s in sources if s.get("node")})
    by = {(s["kind"], s["node"]): s for s in sources}
    items = []
    for node in nodes:
        app, cap = by.get(("app", node)), by.get(("capture", node))
        items.append({"node": node, "area": "AI worker requests (agent, tool, model, HTTP status)",
                      "status": "ok" if app and app["healthy"] else ("stale" if app else "missing"),
                      "detail": "Instrumentation inside ops-center-ai-worker" if app else "The AI worker on this node has not reported"})
        if not cap:
            items.append({"node": node, "area": "Passive network capture (conntrack, DNS, TLS SNI, SYN/RST, ICMP)",
                          "status": "missing", "detail": "No collector has reported from this node: connections the worker does not make through httpx, "
                          "on-the-wire DNS and local drops are not observed here."})
            continue
        stats = cap.get("stats") or {}
        ct = stats.get("conntrack") or {}
        items.append({"node": node, "area": "Passive network capture (conntrack, DNS, TLS SNI, SYN/RST, ICMP)",
                      "status": "ok" if cap["healthy"] and ct.get("listening", False) else "degraded" if cap["healthy"] else "stale",
                      "detail": ct.get("error") or stats.get("docker_error") or "conntrack events and header capture on the AI container bridges"})
        items.append({"node": node, "area": "Byte counters per connection",
                      "status": "ok" if ct.get("acct") else "missing",
                      "detail": "nf_conntrack_acct=1" if ct.get("acct") else "nf_conntrack_acct=0: only HTTP body sizes from the worker are known"})
    items.append({"node": None, "area": "Firewall drop logs (rule that blocked)",
                  "status": "missing",
                  "detail": "No firewall on the AI nodes exports drop logs (firewalld LogDenied=off; no host firewall on docker-02). "
                            "Blocks are shown only when observed passively (ICMP admin-prohibited, or a SYN the kernel never forwarded); "
                            "a missing rule id and a low count do not mean nothing was blocked."})
    items.append({"node": None, "area": "Pi-hole / resolver query logs",
                  "status": "missing",
                  "detail": "Not integrated. DNS blocks are recognised only from the answer on the wire (0.0.0.0/::); "
                            "an NXDOMAIN-mode blocklist looks like an ordinary DNS error."})
    items.append({"node": None, "area": "Encrypted content",
                  "status": "by_design",
                  "detail": "No TLS interception or decryption: HTTPS bodies and headers are never seen on the wire. "
                            "Method, path and status come from the worker's own instrumentation."})
    return items


@router.get("/ai-traffic/overview")
async def overview(window: str = Query("1h", max_length=8), db: AsyncSession = Depends(get_db)) -> dict:
    delta = _window(window)
    since = datetime.now(timezone.utc) - delta
    params = {"since": since, "blocked": list(BLOCKED), "failed": list(FAILED)}
    totals = (await db.execute(text(
        "SELECT count(*) FILTER (WHERE kind <> 'access') AS events, "
        "  count(*) FILTER (WHERE kind IN ('http','tcp','udp')) AS connections, "
        "  count(*) FILTER (WHERE kind = 'http') AS requests, "
        "  count(*) FILTER (WHERE kind = 'dns') AS dns, "
        "  count(*) FILTER (WHERE outcome = 'ok') AS ok, "
        "  count(*) FILTER (WHERE outcome = ANY(:failed)) AS failed, "
        "  count(*) FILTER (WHERE outcome = ANY(:blocked)) AS blocked, "
        "  coalesce(sum(bytes_sent), 0) AS bytes_sent, coalesce(sum(bytes_recv), 0) AS bytes_recv "
        "FROM ai_traffic_events WHERE ts >= :since"), params)).mappings().one()
    recent = (await db.execute(text(
        "SELECT count(*) FILTER (WHERE ts >= now() - interval '1 minute') AS minute, "
        "       count(*) AS hour FROM ai_traffic_events "
        "WHERE ts >= now() - interval '1 hour' AND kind IN ('http','tcp','udp')"))).mappings().one()
    active = (await db.execute(text(
        "SELECT count(*) FROM ai_traffic_events WHERE kind IN ('tcp','udp','http') AND ended_at IS NULL "
        "AND 'capture' = ANY(sources) AND ts >= now() - interval '1 day'"))).scalar()
    by_outcome = (await db.execute(text(
        "SELECT outcome, count(*) AS n FROM ai_traffic_events WHERE ts >= :since GROUP BY outcome ORDER BY n DESC"),
        params)).mappings().all()
    agents = (await db.execute(text(
        "SELECT coalesce(agent_slug, '-') AS agent, count(*) AS n, count(*) FILTER (WHERE outcome <> 'ok') AS problems, "
        "  coalesce(sum(bytes_sent),0) + coalesce(sum(bytes_recv),0) AS bytes "
        "FROM ai_traffic_events WHERE ts >= :since AND kind <> 'access' GROUP BY 1 ORDER BY n DESC LIMIT 8"),
        params)).mappings().all()
    destinations = (await db.execute(text(
        "SELECT coalesce(dst_host, dst_ip) AS destination, max(provider) AS provider, count(*) AS n, "
        "  count(*) FILTER (WHERE outcome <> 'ok') AS problems, coalesce(sum(bytes_sent),0) + coalesce(sum(bytes_recv),0) AS bytes "
        "FROM ai_traffic_events WHERE ts >= :since AND kind IN ('http','tcp','udp') "
        "GROUP BY 1 ORDER BY n DESC LIMIT 10"), params)).mappings().all()
    models = (await db.execute(text(
        "SELECT provider, model, count(*) AS n, count(*) FILTER (WHERE outcome <> 'ok') AS problems "
        "FROM ai_traffic_events WHERE ts >= :since AND model IS NOT NULL AND kind = 'http' "
        "GROUP BY 1, 2 ORDER BY n DESC LIMIT 8"), params)).mappings().all()
    bucket = max(60, int(delta.total_seconds() / 48))
    series = (await db.execute(text(
        "SELECT to_timestamp(floor(extract(epoch FROM ts) / :bucket) * :bucket) AS t, "
        "  count(*) FILTER (WHERE outcome = 'ok') AS ok, count(*) FILTER (WHERE outcome = ANY(:failed)) AS failed, "
        "  count(*) FILTER (WHERE outcome = ANY(:blocked)) AS blocked, "
        "  coalesce(sum(bytes_sent),0) AS bytes_sent, coalesce(sum(bytes_recv),0) AS bytes_recv "
        "FROM ai_traffic_events WHERE ts >= :since AND kind <> 'access' GROUP BY 1 ORDER BY 1"),
        {**params, "bucket": bucket})).mappings().all()
    sources = await _sources(db)
    return {
        "window": window, "since": since.isoformat(), "bucket_seconds": bucket,
        "totals": _row(totals), "requests_last_minute": recent["minute"], "requests_last_hour": recent["hour"],
        "active_connections": active, "by_outcome": [_row(r) for r in by_outcome],
        "top_agents": [_row(r) for r in agents], "top_destinations": [_row(r) for r in destinations],
        "top_models": [_row(r) for r in models], "series": [_row(r) for r in series],
        "sources": [{k: s[k] for k in ("name", "kind", "node", "last_seen", "healthy", "summary")} for s in sources],
        "coverage": _coverage(sources),
    }


@router.get("/ai-traffic/sources")
async def sources(db: AsyncSession = Depends(get_db)) -> dict:
    items = await _sources(db)
    return {"sources": items, "coverage": _coverage(items)}


# --------------------------------------------------------------------------- events

@router.get("/ai-traffic/events")
async def events(
    f: EventFilter = Depends(_event_filter),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100_000),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role("operator")),
) -> dict:
    where, values = _filters(f)
    rows = (await db.execute(text(
        f"SELECT {EVENT_COLUMNS} FROM ai_traffic_events{where} ORDER BY ts {order}, id {order} LIMIT :limit OFFSET :offset"),
        {**values, "limit": limit, "offset": offset})).mappings().all()
    total = None
    if offset == 0 and f.after_id is None:
        total = (await db.execute(text(f"SELECT count(*) FROM (SELECT 1 FROM ai_traffic_events{where} LIMIT 10001) c"), values)).scalar()
    max_id = (await db.execute(text("SELECT coalesce(max(id), 0) FROM ai_traffic_events"))).scalar()
    return {"events": [_row(r) for r in rows], "total": total, "total_capped": total is not None and total > 10000, "max_id": max_id}


@router.get("/ai-traffic/events/{event_id}")
async def event_detail(event_id: int, db: AsyncSession = Depends(get_db), _user=Depends(require_role("operator"))) -> dict:
    row = (await db.execute(text(f"SELECT {EVENT_COLUMNS}, observations, obs_keys, detail FROM ai_traffic_events WHERE id = :id"),
                            {"id": event_id})).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "event not found")
    event = _row(row)
    chain = []
    if event.get("span_id"):
        chain = [_row(r) for r in (await db.execute(text(
            "WITH RECURSIVE up AS (SELECT * FROM ai_trace_spans WHERE span_id = :span "
            "  UNION ALL SELECT s.* FROM ai_trace_spans s JOIN up ON s.span_id = up.parent_span_id) "
            "SELECT span_id, parent_span_id, kind, name, agent_slug, started_at, ended_at, duration_ms, status FROM up"),
            {"span": event["span_id"]})).mappings().all()][::-1]
    return {"event": event, "span_chain": chain}


@router.get("/ai-traffic/blocked")
async def blocked(window: str = Query("24h", max_length=8), limit: int = Query(200, ge=1, le=500),
                  db: AsyncSession = Depends(get_db), _user=Depends(require_role("operator"))) -> dict:
    since = datetime.now(timezone.utc) - _window(window)
    rows = (await db.execute(text(
        f"SELECT {EVENT_COLUMNS} FROM ai_traffic_events WHERE ts >= :since AND outcome <> 'ok' ORDER BY ts DESC LIMIT :limit"),
        {"since": since, "limit": limit})).mappings().all()
    counts = (await db.execute(text(
        "SELECT outcome, count(*) AS n FROM ai_traffic_events WHERE ts >= :since AND outcome <> 'ok' GROUP BY 1"),
        {"since": since})).mappings().all()
    # Approval decisions are the AI layer's own access control: shown, not copied.
    actions = (await db.execute(text(
        "SELECT a.id, a.tool, a.action, a.status, a.risk, a.requested_at, a.expires_at, a.approved_by, a.task_id, g.slug AS agent_slug "
        "FROM ai_actions a LEFT JOIN ai_agents g ON g.id = a.agent_id "
        "WHERE a.requested_at >= :since AND a.status IN ('rejected', 'expired') ORDER BY a.requested_at DESC LIMIT 100"),
        {"since": since})).mappings().all()
    return {"events": [_row(r) for r in rows], "counts": {r["outcome"]: r["n"] for r in counts},
            "approval_denials": [_row(r) for r in actions]}


# --------------------------------------------------------------------------- traces

@router.get("/ai-traffic/traces")
async def traces(window: str = Query("24h", max_length=8), agent: str | None = Query(None, max_length=50),
                 limit: int = Query(50, ge=1, le=200), db: AsyncSession = Depends(get_db),
                 _user=Depends(require_role("operator"))) -> dict:
    since = datetime.now(timezone.utc) - _window(window)
    rows = (await db.execute(text(
        "SELECT s.trace_id, min(s.started_at) AS started_at, max(s.ended_at) AS ended_at, max(s.task_id::text) AS task_id, "
        "  (array_agg(s.agent_slug ORDER BY s.started_at) FILTER (WHERE s.kind = 'agent'))[1] AS root_agent, "
        "  array_agg(DISTINCT s.agent_slug) FILTER (WHERE s.agent_slug IS NOT NULL) AS agents, "
        "  count(*) AS spans, count(*) FILTER (WHERE s.status = 'error') AS errors, "
        "  (SELECT count(*) FROM ai_traffic_events e WHERE e.trace_id = s.trace_id) AS events, "
        "  (SELECT count(*) FROM ai_traffic_events e WHERE e.trace_id = s.trace_id AND e.outcome <> 'ok') AS problems "
        "FROM ai_trace_spans s WHERE s.started_at >= :since "
        "GROUP BY s.trace_id HAVING (CAST(:agent AS text) IS NULL OR CAST(:agent AS text) = ANY(array_agg(s.agent_slug))) "
        "ORDER BY min(s.started_at) DESC LIMIT :limit"), {"since": since, "agent": agent, "limit": limit})).mappings().all()
    return {"traces": [_row(r) for r in rows]}


@router.get("/ai-traffic/traces/{trace_id}")
async def trace(trace_id: str, db: AsyncSession = Depends(get_db), _user=Depends(require_role("operator"))) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", trace_id):
        raise HTTPException(422, "invalid trace id")
    spans = (await db.execute(text(
        "SELECT span_id, parent_span_id, task_id, kind, name, agent_slug, node, started_at, ended_at, duration_ms, status, attributes "
        "FROM ai_trace_spans WHERE trace_id = :t ORDER BY started_at, span_id"), {"t": trace_id})).mappings().all()
    rows = (await db.execute(text(
        f"SELECT {EVENT_COLUMNS} FROM ai_traffic_events WHERE trace_id = :t ORDER BY ts LIMIT 2000"), {"t": trace_id})).mappings().all()
    task = None
    try:
        task_id = uuid.UUID(trace_id)
        task = (await db.execute(text(
            "SELECT t.id, t.source, t.status, t.requested_by, t.created_at, t.completed_at, g.slug AS agent_slug, g.name AS agent_name "
            "FROM ai_tasks t LEFT JOIN ai_agents g ON g.id = t.agent_id WHERE t.id = :id"), {"id": task_id})).mappings().one_or_none()
    except Exception:
        task = None
    if not spans and not rows:
        raise HTTPException(404, "trace not found")
    return {"trace_id": trace_id, "task": _row(task) if task else None,
            "spans": [_row(s) for s in spans], "events": [_row(r) for r in rows]}


# --------------------------------------------------------------------------- flow graph

@router.get("/ai-traffic/flow")
async def flow(window: str = Query("1h", max_length=8), db: AsyncSession = Depends(get_db),
               _user=Depends(require_role("operator"))) -> dict:
    since = datetime.now(timezone.utc) - _window(window)
    rows = (await db.execute(text(
        "SELECT coalesce(agent_slug, coalesce(process, container, 'unattributed')) AS origin, agent_slug IS NOT NULL AS is_agent, "
        "  CASE WHEN mcp_tool IS NOT NULL THEN 'mcp:' || mcp_tool WHEN tool IS NOT NULL THEN 'tool:' || tool "
        "       WHEN model IS NOT NULL THEN 'model:' || model ELSE NULL END AS via, "
        "  coalesce(dst_host, dst_ip) || CASE WHEN dst_port IS NOT NULL AND kind <> 'dns' THEN ':' || dst_port ELSE '' END AS destination, "
        "  max(provider) AS provider, count(*) AS n, count(*) FILTER (WHERE outcome <> 'ok') AS problems, "
        "  count(*) FILTER (WHERE outcome = ANY(:blocked)) AS blocked, "
        "  coalesce(sum(bytes_sent),0) + coalesce(sum(bytes_recv),0) AS bytes, max(ts) AS last_seen "
        "FROM ai_traffic_events WHERE ts >= :since AND kind IN ('http','tcp','udp','dns') "
        "GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 400"), {"since": since, "blocked": list(BLOCKED)})).mappings().all()
    return {"window": window, "links": [_row(r) for r in rows]}


# --------------------------------------------------------------------------- export

def _csv_cell(value) -> str:
    """Text a spreadsheet will not execute: cells starting with = + - @ tab or CR get a leading quote."""
    if value is None:
        return ""
    text_value = "|".join(map(str, value)) if isinstance(value, list) else str(value)
    if isinstance(value, str | list) and text_value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text_value
    return text_value


@router.get("/ai-traffic/export")
async def export(
    f: EventFilter = Depends(_event_filter),
    format: str = Query("json", pattern="^(json|csv)$"),
    limit: int = Query(50_000, ge=1, le=200_000),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role("operator")),
):
    where, values = _filters(f)
    rows = (await db.execute(text(
        f"SELECT {EVENT_COLUMNS}, sources, detail FROM ai_traffic_events{where} ORDER BY ts LIMIT :limit"),
        {**values, "limit": limit})).mappings().all()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if format == "json":
        body = json.dumps({"exported_at": stamp, "events": [_row(r) for r in rows]}, default=str)
        return Response(body, media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="ai-traffic-{stamp}.json"'})

    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(CSV_FIELDS)
        for r in rows:
            item = _row(r)
            writer.writerow([_csv_cell(item[c]) for c in CSV_FIELDS])
            if buf.tell() > 65536:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()
    return StreamingResponse(generate(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="ai-traffic-{stamp}.csv"'})


# --------------------------------------------------------------------------- settings & captures

class SettingsIn(BaseModel):
    retention_days: int = Field(ge=1, le=365)
    capture_retention_hours: int = Field(ge=1, le=168)


@router.get("/ai-traffic/settings")
async def get_traffic_settings(db: AsyncSession = Depends(get_db)) -> dict:
    row = (await db.execute(text("SELECT retention_days, capture_retention_hours, updated_by, updated_at FROM ai_traffic_settings WHERE id = 1"))).mappings().one()
    stats = (await db.execute(text(
        "SELECT (SELECT count(*) FROM ai_traffic_events) AS events, (SELECT count(*) FROM ai_trace_spans) AS spans, "
        "pg_total_relation_size('ai_traffic_events') + pg_total_relation_size('ai_trace_spans') AS bytes, "
        "(SELECT min(ts) FROM ai_traffic_events) AS oldest"))).mappings().one()
    return {**_row(row), "storage": _row(stats), "ingest_configured": bool(get_settings().ai_traffic_ingest_token)}


@router.put("/ai-traffic/settings")
async def put_traffic_settings(body: SettingsIn, db: AsyncSession = Depends(get_db), user=Depends(require_role("admin"))) -> dict:
    await db.execute(text(
        "UPDATE ai_traffic_settings SET retention_days = :d, capture_retention_hours = :h, updated_by = :u, updated_at = now() WHERE id = 1"),
        {"d": body.retention_days, "h": body.capture_retention_hours, "u": user.username})
    await db.commit()
    return {"ok": True}


class CaptureIn(BaseModel):
    node: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")
    seconds: int = Field(30, ge=1, le=300)
    max_mb: int = Field(5, ge=1, le=20)


@router.get("/ai-traffic/captures")
async def list_captures(db: AsyncSession = Depends(get_db), _user=Depends(require_role("admin"))) -> dict:
    rows = (await db.execute(text(
        "SELECT id, node, requested_by, requested_at, seconds, max_bytes, status, started_at, finished_at, packets, size, error, expires_at "
        "FROM ai_traffic_captures ORDER BY requested_at DESC LIMIT 50"))).mappings().all()
    return {"captures": [_row(r) for r in rows]}


@router.post("/ai-traffic/captures")
async def request_capture(body: CaptureIn, db: AsyncSession = Depends(get_db), user=Depends(require_role("admin"))) -> dict:
    known = (await db.execute(text("SELECT 1 FROM ai_traffic_sources WHERE kind = 'capture' AND node = :n AND last_seen > now() - interval '2 minutes'"),
                              {"n": body.node})).scalar()
    if not known:
        raise HTTPException(409, "no live collector on that node")
    busy = (await db.execute(text("SELECT 1 FROM ai_traffic_captures WHERE node = :n AND status IN ('pending','running') "
                                  "AND requested_at > now() - interval '10 minutes'"), {"n": body.node})).scalar()
    if busy:
        raise HTTPException(409, "a capture is already pending or running on that node")
    capture_id = (await db.execute(text(
        "INSERT INTO ai_traffic_captures (node, requested_by, seconds, max_bytes, filter) "
        "VALUES (:n, :u, :s, :b, CAST(:f AS jsonb)) RETURNING id"),
        {"n": body.node, "u": user.username, "s": body.seconds, "b": body.max_mb * 1024 * 1024,
         "f": json.dumps({"scope": "AI container addresses", "snaplen": 128})})).scalar()
    await db.commit()
    return {"id": str(capture_id)}


@router.get("/ai-traffic/captures/{capture_id}/download")
async def download_capture(capture_id: uuid.UUID, db: AsyncSession = Depends(get_db), _user=Depends(require_role("admin"))):
    row = (await db.execute(text("SELECT node, finished_at, data FROM ai_traffic_captures WHERE id = :id AND status = 'done' AND data IS NOT NULL"),
                            {"id": capture_id})).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "capture not available")
    stamp = row["finished_at"].strftime("%Y%m%dT%H%M%SZ") if row["finished_at"] else "capture"
    return Response(bytes(row["data"]), media_type="application/vnd.tcpdump.pcap",
                    headers={"Content-Disposition": f'attachment; filename="ai-traffic-{row["node"]}-{stamp}.pcap"'})


# --------------------------------------------------------------------------- live map

# Ports whose usual service helps read an internal connection; shown as "usually", never asserted.
WELL_KNOWN_PORTS = {22: "SSH", 53: "DNS", 80: "HTTP", 443: "HTTPS", 853: "DNS over TLS", 5432: "PostgreSQL", 6379: "Redis",
                    26379: "Redis Sentinel", 8000: "HTTP (API)", 8008: "Patroni", 9090: "Prometheus", 3100: "Loki", 11434: "Ollama"}
MAP_GROUP_LIMIT = 1500


def classify_destination(ip: str | None) -> str:
    """external (public, geolocatable), internal (private network), local (same host) or unknown."""
    import ipaddress
    if not ip:
        return "unknown"
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "unknown"
    if addr.is_loopback or addr.is_unspecified or addr.is_link_local:
        return "local"
    if addr.is_global:
        return "external"
    return "internal" if addr.is_private or (addr.version == 4 and addr in ipaddress.ip_network("100.64.0.0/10")) else "unknown"


_geo_cache: dict[str, tuple] = {}


def _geo(ip: str) -> dict | None:
    """Approximate location of a public address from the local GeoIP database; never an external lookup."""
    if ip not in _geo_cache:
        from app.services.traffic_watch import _geolocate
        if len(_geo_cache) > 20000:
            _geo_cache.clear()
        _geo_cache[ip] = _geolocate(ip)
    lat, lon, city, country = _geo_cache[ip]
    if lat is None or lon is None:
        return None
    return {"lat": round(float(lat), 2), "lon": round(float(lon), 2), "city": city, "country": country}


def geoip_available() -> bool:
    from pathlib import Path
    return Path(get_settings().geoip_db_path).is_file()


@router.get("/ai-traffic/map")
async def traffic_map(
    f: EventFilter = Depends(_event_filter),
    category: str = Query("all", pattern="^(all|ai|system)$"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role("operator")),
) -> dict:
    """Connections grouped for the Live Map: one row per who -> where:port, protocol and result.

    Aggregated in SQL so thousands of identical events (Celery to Redis, for
    example) become one group with a count and byte totals. Public addresses
    get an approximate location from the local GeoIP database; private,
    loopback and unknown destinations are never placed on the world map.
    Read-only: one SELECT, nothing is changed.
    """
    if not (f.window or f.since):
        f.window = "15m"
    where, values = _filters(f)
    where = (where + " AND " if where else " WHERE ") + "kind <> 'dns'"
    if category == "ai":
        where += " AND (agent_slug IS NOT NULL OR model IS NOT NULL OR provider IS NOT NULL OR tool IS NOT NULL OR mcp_tool IS NOT NULL)"
    elif category == "system":
        where += " AND agent_slug IS NULL AND model IS NULL AND provider IS NULL AND tool IS NULL AND mcp_tool IS NULL"
    values.update({"blocked": list(BLOCKED), "limit": MAP_GROUP_LIMIT + 1})
    rows = (await db.execute(text(
        "SELECT agent_slug AS agent, process, node, dst_ip, dst_port, kind, "
        "  CASE WHEN outcome = 'ok' THEN 'ok' WHEN outcome = ANY(:blocked) THEN 'blocked' ELSE 'failed' END AS status, "
        "  (container IS NOT NULL OR 'app' = ANY(sources)) AS outbound, "
        "  max(dst_host) AS dst_host, max(protocol) AS protocol, max(model) AS model, max(provider) AS provider, "
        "  max(container) AS container, max(tool) AS tool, max(mcp_tool) AS mcp_tool, "
        "  min(src_ip) AS src_ip, count(DISTINCT src_ip) AS src_count, "
        "  bool_or(model IS NOT NULL OR provider IS NOT NULL OR tool IS NOT NULL OR mcp_tool IS NOT NULL) AS ai_attr, "
        "  count(*) AS count, coalesce(sum(bytes_sent), 0)::bigint AS bytes_sent, coalesce(sum(bytes_recv), 0)::bigint AS bytes_recv, "
        "  count(*) FILTER (WHERE bytes_sent IS NULL AND bytes_recv IS NULL) AS unmeasured, "
        "  min(ts) AS first_seen, max(ts) AS last_seen, max(reason) FILTER (WHERE outcome <> 'ok') AS reason, "
        "  array_agg(DISTINCT outcome) AS outcomes, max(id) AS last_id "
        f"FROM ai_traffic_events{where} "
        "GROUP BY agent_slug, process, node, dst_ip, dst_port, kind, 7, 8 "
        "ORDER BY max(ts) DESC LIMIT :limit"), values)).mappings().all()
    truncated = len(rows) > MAP_GROUP_LIMIT
    nodes = sorted({r["node"] for r in rows if r["node"]})
    sites = {}
    if nodes:
        from app.models.host import Host
        from sqlalchemy import select
        hosts = (await db.execute(select(Host.hostname, Host.latitude, Host.longitude).where(Host.hostname.in_(nodes)))).all()
        sites = {h: {"lat": lat, "lon": lon} for h, lat, lon in hosts if lat is not None and lon is not None}
    groups = []
    for r in rows[:MAP_GROUP_LIMIT]:
        item = _row(r)
        scope = classify_destination(item["dst_ip"])
        item["scope"] = scope
        # AI traffic is decided by the event's own attribution (agent, model, provider, tool), never by destination.
        item["category"] = "ai" if r["agent"] is not None or r["ai_attr"] else "system"
        del item["ai_attr"]
        item["direction"] = "outbound" if item.pop("outbound") else "inbound"
        item["service"] = WELL_KNOWN_PORTS.get(item["dst_port"]) if scope != "external" else None
        item["geo"] = _geo(item["dst_ip"]) if scope == "external" else None
        item["key"] = "|".join(str(r[k] or "") for k in ("agent", "process", "node", "dst_ip", "dst_port", "kind", "status"))
        groups.append(item)
    countries: dict[str, dict] = {}
    for g in groups:
        if g["scope"] == "external":
            name = (g["geo"] or {}).get("country") or "Location unknown"
            c = countries.setdefault(name, {"country": name, "count": 0, "bytes": 0, "problems": 0})
            c["count"] += g["count"]
            c["bytes"] += g["bytes_sent"] + g["bytes_recv"]
            c["problems"] += g["count"] if g["status"] != "ok" else 0
    sources = await _sources(db)
    return {
        "since": values.get("since").isoformat() if values.get("since") else None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "groups": groups, "truncated": truncated, "group_limit": MAP_GROUP_LIMIT,
        "sites": sites, "countries": sorted(countries.values(), key=lambda c: -c["count"]),
        "geoip": geoip_available(),
        "coverage": _coverage(sources),
    }
