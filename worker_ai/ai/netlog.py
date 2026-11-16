"""AI Traffic Monitor: passive record of the AI worker's network activity.

Read-only instrumentation, nothing here changes a request:

* Every httpx/httpx2 request (model providers, web tools, Prometheus/Loki/
  Alertmanager, MCP, Talk) is recorded by wrapping the transport's
  handle_request: method, host, path without query, status, bytes, timing,
  the exact local and remote address of the socket, and a failure class.
  Exceptions and responses pass through unchanged.
* socket.getaddrinfo is wrapped the same way to record DNS lookups and
  their failures (resolution itself is untouched).
* Spans (agent run, model call, tool call) carry OpenTelemetry GenAI
  attribute names, so every network event can be followed back to the
  agent, tool and task that caused it. The trace id of a task is its UUID.
* Access-control decisions made by the agent loop (tool not granted, host
  not allowed, approval required, budget stop, MCP LAN rule) are recorded
  as events of kind "access".

Prompts, responses, headers, query strings and request bodies are never
stored; only sizes. Recording never blocks the caller: events go into a
bounded queue drained by one background thread per process that writes
batches through ai_traffic_ingest(). A full queue drops the event and
counts it, and the counts are reported as the source's heartbeat so lost
telemetry is visible instead of silently missing.
"""

import json
import logging
import os
import queue
import re
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

NODE = os.environ.get("OPS_LOCAL_HOSTNAME") or socket.gethostname()
CONTAINER = os.environ.get("AI_TRAFFIC_CONTAINER", "ops-center-ai-worker")
SOURCE = "app"
QUEUE_SIZE = 5000
BATCH_SIZE = 200
FLUSH_SECONDS = 1.0
HEARTBEAT_SECONDS = 30.0

# The fields of the current span every event inherits.
CTX: ContextVar[dict | None] = ContextVar("ai_traffic_context", default=None)
_CTX_KEYS = ("trace_id", "span_id", "task_id", "agent_slug", "tool", "mcp_tool", "provider", "model")

_SECRET_SEGMENT = re.compile(r"^(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9_\-:.=]{24,}$")
_KNOWN_PROVIDERS = {
    "api.anthropic.com": "anthropic", "api.openai.com": "openai", "api.mistral.ai": "mistral",
    "generativelanguage.googleapis.com": "google", "openrouter.ai": "openrouter",
}


def mask_path(path: str) -> str:
    """Path without query; segments that look like tokens or keys become ***."""
    parts = path.split("?", 1)[0].split("#", 1)[0].split("/")
    return "/".join("***" if _SECRET_SEGMENT.match(p) else p for p in parts)[:500]


def classify(exc: BaseException) -> tuple[str, str]:
    """(outcome, reason) for a failed request. A timeout is never called a block."""
    name = type(exc).__name__
    chain, cause = [], exc
    while cause is not None and len(chain) < 6:
        chain.append(cause)
        cause = cause.__cause__ or cause.__context__
    text = " | ".join(f"{type(c).__name__}: {c}" for c in chain)[:480]
    low = text.lower()
    if "timeout" in name.lower() or any(isinstance(c, (TimeoutError, socket.timeout)) for c in chain):
        return "timeout", text or name
    if any(isinstance(c, socket.gaierror) for c in chain) or "name or service not known" in low \
            or "temporary failure in name resolution" in low or "nodename nor servname" in low \
            or "no address associated" in low:
        return "dns_error", text
    if "ssl" in low or "certificate" in low or "tls" in low:
        return "tls_error", text
    if any(isinstance(c, ConnectionRefusedError) for c in chain) or "connection refused" in low:
        return "connect_error", "connection refused: " + text
    if "no route to host" in low or "network is unreachable" in low or "host is unreachable" in low:
        # Also what an ICMP-rejecting firewall looks like from here; only the
        # passive capture can tell the ICMP code, so this stays a connect error.
        return "connect_error", text
    if "connect" in name.lower() or "connection" in low:
        return "connect_error", text
    return "unknown", text or name


def http_outcome(status: int) -> str:
    if status in (401, 403, 407, 451):
        return "remote_reject"
    return "http_error" if status >= 400 else "ok"


# --------------------------------------------------------------------------- spans

@dataclass
class Span:
    span_id: str
    trace_id: str
    parent_span_id: str | None
    kind: str
    name: str
    started: float
    mono: float
    ctx: dict
    attributes: dict = field(default_factory=dict)
    values: dict = field(default_factory=dict)
    token: object = None
    ended: bool = False


def current() -> dict:
    return CTX.get() or {}


def trace_for_task(task_id) -> str | None:
    if not task_id:
        return None
    try:
        return uuid.UUID(str(task_id)).hex
    except ValueError:
        return None


def start_span(kind: str, name: str, attributes: dict | None = None, **ctx) -> Span:
    parent = current()
    trace_id = parent.get("trace_id") or trace_for_task(ctx.get("task_id")) or uuid.uuid4().hex
    span = Span(os.urandom(8).hex(), trace_id, parent.get("span_id"), kind, str(name)[:200],
                time.time(), time.monotonic(), parent, dict(attributes or {}))
    # A key passed as None clears it: a delegated agent's span does not inherit the caller's tool.
    values = {k: v for k, v in {**parent, **{k: v for k, v in ctx.items() if k in _CTX_KEYS}}.items() if v is not None}
    if values.get("task_id") is not None:
        values["task_id"] = str(values["task_id"])
    values.update(trace_id=trace_id, span_id=span.span_id)
    span.values = values
    span.token = CTX.set(values)
    _emit_span(span, None)
    return span


def end_span(span: Span, status: str = "ok", **attributes) -> None:
    if span.ended:
        return
    span.ended = True
    span.attributes.update({k: v for k, v in attributes.items() if v is not None})
    try:
        CTX.reset(span.token)
    except (ValueError, RuntimeError):
        # Ended in another context (a thread pool); restore the parent here.
        CTX.set(span.ctx or None)
    _emit_span(span, status)


@contextmanager
def span(kind: str, name: str, attributes: dict | None = None, **ctx):
    s = start_span(kind, name, attributes, **ctx)
    try:
        yield s
    except BaseException as exc:
        end_span(s, "error", error=type(exc).__name__)
        raise
    end_span(s, s.attributes.pop("status", "ok"))


def _emit_span(s: Span, status: str | None) -> None:
    _put({
        "type": "span", "span_id": s.span_id, "trace_id": s.trace_id, "parent_span_id": s.parent_span_id,
        "task_id": s.values.get("task_id"), "kind": s.kind, "name": s.name,
        "agent_slug": s.values.get("agent_slug"), "node": NODE, "ts": s.started,
        "ended_at": time.time() if status is not None else None,
        "duration_ms": int((time.monotonic() - s.mono) * 1000) if status is not None else None,
        "status": status or "running", "attributes": _jsonable(s.attributes),
    })


def _jsonable(value: dict) -> dict:
    return json.loads(json.dumps(value, default=str))


# --------------------------------------------------------------------------- events

def access(reason: str, *, tool: str | None = None, host: str | None = None, rule: str | None = None, **detail) -> None:
    """An access-control decision by the AI layer itself (no network request was sent)."""
    ctx = current()
    _put({
        "type": "event", "source": SOURCE, "obs_id": os.urandom(8).hex(), "ts": time.time(), "node": NODE,
        "kind": "access", "container": CONTAINER, "process": "celery",
        "dst_host": host, "protocol": None, "outcome": "ai_access_control", "reason": str(reason)[:480],
        "rule_id": rule, "tool": tool or ctx.get("tool"), **_ctx_fields(ctx),
        "detail": _jsonable({**detail, "container_pid": os.getpid()}),
    })


def _ctx_fields(ctx: dict) -> dict:
    return {k: ctx.get(k) for k in ("trace_id", "span_id", "task_id", "agent_slug", "provider", "model", "mcp_tool")} | (
        {"tool": ctx.get("tool")} if ctx.get("tool") else {})


@dataclass
class _Request:
    obs_id: str
    started: float
    mono: float
    method: str
    scheme: str
    host: str
    port: int | None
    path: str
    bytes_sent: int | None
    ctx: dict
    status: int | None = None
    ttfb_ms: int | None = None
    bytes_recv: int = 0
    src: tuple | None = None
    dst: tuple | None = None
    http_version: str | None = None
    done: bool = False


def _begin(request) -> _Request | None:
    try:
        url = request.url
        length = request.headers.get("content-length")
        sent = int(length) if length and length.isdigit() else None
        if sent is None:
            try:
                sent = len(request.content)
            except Exception:
                sent = None
        return _Request(os.urandom(8).hex(), time.time(), time.monotonic(), request.method, url.scheme,
                        url.host, url.port, mask_path(url.raw_path.decode("ascii", "replace")), sent, current())
    except Exception:
        return None


def _addresses(rec: _Request, extensions) -> None:
    try:
        stream = extensions.get("network_stream")
        if stream is not None:
            rec.src = stream.get_extra_info("client_addr")
            rec.dst = stream.get_extra_info("server_addr")
        version = extensions.get("http_version")
        rec.http_version = version.decode() if isinstance(version, bytes) else version
    except Exception:
        pass


def _finish(rec: _Request, outcome: str = "ok", reason: str | None = None) -> None:
    if rec is None or rec.done:
        return
    rec.done = True
    ctx = rec.ctx
    host = rec.host
    provider = ctx.get("provider") or _KNOWN_PROVIDERS.get(host)
    status = rec.status
    if status is not None and outcome == "ok":
        outcome = http_outcome(status)
        reason = f"HTTP {status}" if outcome != "ok" else None
    protocol = "https" if rec.scheme == "https" else "http"
    if rec.http_version and rec.http_version.upper().startswith("HTTP/2"):
        protocol += "/2"
    _put({
        "type": "event", "source": SOURCE, "obs_id": rec.obs_id, "ts": rec.started, "node": NODE, "kind": "http",
        "ended_at": time.time(), "duration_ms": int((time.monotonic() - rec.mono) * 1000), "ttfb_ms": rec.ttfb_ms,
        "container": CONTAINER, "process": "celery",
        "src_ip": rec.src[0] if rec.src else None, "src_port": rec.src[1] if rec.src else None,
        "dst_ip": rec.dst[0] if rec.dst else (host if _is_literal(host) else _resolved(host)), "dst_port": rec.dst[1] if rec.dst else (
            rec.port or (443 if rec.scheme == "https" else 80)),
        "dst_host": host, "protocol": protocol, "method": rec.method, "path": rec.path, "status_code": status,
        "bytes_sent": rec.bytes_sent, "bytes_recv": rec.bytes_recv if status is not None else None,
        "outcome": outcome, "reason": reason, **_ctx_fields(ctx), "provider": provider,
        "detail": {"container_pid": os.getpid()},
    })


# Recent lookups, so a failed connect still shows which address was tried.
_RESOLVED: dict[str, tuple[str, float]] = {}


def _resolved(host: str) -> str | None:
    hit = _RESOLVED.get(host)
    return hit[0] if hit and time.time() - hit[1] < 300 else None


def _wrap_sync_stream(base, rec):
    class CountingStream(base):
        def __init__(self, inner):
            self._inner = inner

        def __iter__(self):
            try:
                for chunk in self._inner:
                    rec.bytes_recv += len(chunk)
                    yield chunk
            except BaseException as exc:
                _finish(rec, *classify(exc))
                raise

        def close(self):
            try:
                self._inner.close()
            finally:
                _finish(rec)
    return CountingStream


def _wrap_async_stream(base, rec):
    class CountingStream(base):
        def __init__(self, inner):
            self._inner = inner

        async def __aiter__(self):
            try:
                async for chunk in self._inner:
                    rec.bytes_recv += len(chunk)
                    yield chunk
            except BaseException as exc:
                _finish(rec, *classify(exc))
                raise

        async def aclose(self):
            try:
                await self._inner.aclose()
            finally:
                _finish(rec)
    return CountingStream


def _instrument(module) -> bool:
    transport = getattr(module, "HTTPTransport", None)
    if transport is None or getattr(transport, "_ai_traffic", False):
        return False
    sync_handle = transport.handle_request

    def handle_request(self, request):
        rec = _begin(request)
        try:
            response = sync_handle(self, request)
        except BaseException as exc:
            if rec:
                _finish(rec, *classify(exc))
            raise
        if rec:
            try:
                rec.status = response.status_code
                rec.ttfb_ms = int((time.monotonic() - rec.mono) * 1000)
                _addresses(rec, response.extensions)
                response.stream = _wrap_sync_stream(module.SyncByteStream, rec)(response.stream)
            except Exception:
                _finish(rec)
        return response

    transport.handle_request = handle_request
    transport._ai_traffic = True

    async_transport = getattr(module, "AsyncHTTPTransport", None)
    if async_transport is not None:
        async_handle = async_transport.handle_async_request

        async def handle_async_request(self, request):
            rec = _begin(request)
            try:
                response = await async_handle(self, request)
            except BaseException as exc:
                if rec:
                    _finish(rec, *classify(exc))
                raise
            if rec:
                try:
                    rec.status = response.status_code
                    rec.ttfb_ms = int((time.monotonic() - rec.mono) * 1000)
                    _addresses(rec, response.extensions)
                    response.stream = _wrap_async_stream(module.AsyncByteStream, rec)(response.stream)
                except Exception:
                    _finish(rec)
            return response

        async_transport.handle_async_request = handle_async_request
    return True


_original_getaddrinfo = socket.getaddrinfo


def _getaddrinfo(host, port, *args, **kwargs):
    started, mono = time.time(), time.monotonic()
    try:
        result = _original_getaddrinfo(host, port, *args, **kwargs)
    except BaseException as exc:
        _dns_event(host, port, started, mono, [], *classify(exc))
        raise
    answers = sorted({r[4][0] for r in result})
    _dns_event(host, port, started, mono, answers, "ok", None)
    return result


def _dns_event(host, port, started, mono, answers, outcome, reason) -> None:
    try:
        name = host.decode() if isinstance(host, bytes) else str(host or "")
        if not name or _is_literal(name):
            return
        if answers:
            _RESOLVED[name] = (answers[0], time.time())
        _put({
            "type": "event", "source": SOURCE, "obs_id": os.urandom(8).hex(), "ts": started, "node": NODE,
            "kind": "dns", "ended_at": time.time(), "duration_ms": int((time.monotonic() - mono) * 1000),
            "container": CONTAINER, "process": "celery", "dst_host": name[:253],
            "dst_port": port if isinstance(port, int) else None, "protocol": "dns",
            "outcome": "dns_error" if outcome == "dns_error" else outcome, "reason": reason,
            **_ctx_fields(current()),
            "detail": {"answers": answers[:16], "resolver": "getaddrinfo", "container_pid": os.getpid()},
        })
    except Exception:
        pass


def _is_literal(name: str) -> bool:
    try:
        socket.inet_pton(socket.AF_INET6 if ":" in name else socket.AF_INET, name)
        return True
    except OSError:
        return False


_ENABLED = False


def install() -> None:
    """Instrument httpx, httpx2 and getaddrinfo once per interpreter. Off with AI_TRAFFIC_APP=0.

    Until this runs (unit tests, the API importing shared code) nothing is recorded."""
    global _ENABLED
    if os.environ.get("AI_TRAFFIC_APP", "1") == "0":
        return
    _ENABLED = True
    for name in ("httpx", "httpx2"):
        try:
            _instrument(__import__(name))
        except ImportError:
            pass
    if socket.getaddrinfo is not _getaddrinfo:
        socket.getaddrinfo = _getaddrinfo
    # Heartbeat from the start, so an idle worker shows as reporting rather than missing.
    # Forked Celery children start their own writer on their first event.
    _writer_for_this_process()


# --------------------------------------------------------------------------- writer

class _Writer:
    def __init__(self):
        self.queue: queue.Queue = queue.Queue(maxsize=QUEUE_SIZE)
        self.pid = os.getpid()
        self.stats = {"emitted": 0, "written": 0, "dropped": 0, "failed_batches": 0, "merged": 0}
        self.last_event = None
        self.thread = threading.Thread(target=self.run, name="ai-traffic-writer", daemon=True)
        self.thread.start()

    def put(self, row: dict) -> None:
        self.stats["emitted"] += 1
        try:
            self.queue.put_nowait(row)
        except queue.Full:
            self.stats["dropped"] += 1

    def run(self) -> None:
        last_beat = 0.0
        while True:
            batch = []
            try:
                batch.append(self.queue.get(timeout=FLUSH_SECONDS))
                while len(batch) < BATCH_SIZE:
                    batch.append(self.queue.get_nowait())
            except queue.Empty:
                pass
            if batch:
                self.write(batch)
            if time.monotonic() - last_beat >= HEARTBEAT_SECONDS:
                last_beat = time.monotonic()
                self.heartbeat()

    def write(self, batch: list[dict]) -> None:
        from sqlalchemy import text
        from worker_ai.db import engine
        try:
            with engine.begin() as conn:
                merged = conn.execute(text("SELECT ai_traffic_ingest(CAST(:rows AS jsonb))"),
                                      {"rows": json.dumps(batch, default=str)}).scalar()
            self.stats["written"] += len(batch)
            self.stats["merged"] += int(merged or 0)
            self.last_event = time.time()
        except Exception as exc:
            # Telemetry never fails the agent; the loss is counted and shown.
            self.stats["failed_batches"] += 1
            self.stats["dropped"] += len(batch)
            logger.warning("AI traffic batch of %s events not stored: %s", len(batch), type(exc).__name__)

    def heartbeat(self) -> None:
        from sqlalchemy import text
        from worker_ai.db import engine
        process = {str(self.pid): {**self.stats, "queued": self.queue.qsize(), "ts": time.time()}}
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    "INSERT INTO ai_traffic_sources (name, kind, node, last_seen, last_event_at, stats) "
                    "VALUES (:name, 'app', :node, now(), to_timestamp(:last), "
                    "        jsonb_build_object('processes', CAST(:proc AS jsonb))) "
                    "ON CONFLICT (name) DO UPDATE SET last_seen = now(), node = EXCLUDED.node, "
                    "  last_event_at = greatest(ai_traffic_sources.last_event_at, EXCLUDED.last_event_at), "
                    "  stats = ai_traffic_sources.stats || jsonb_build_object('processes', "
                    "          coalesce(ai_traffic_sources.stats->'processes', '{}'::jsonb) || CAST(:proc AS jsonb))"),
                    {"name": f"app:{NODE}", "node": NODE, "last": self.last_event, "proc": json.dumps(process)})
        except Exception:
            pass


_writer: _Writer | None = None
_writer_lock = threading.Lock()


def _put(row: dict) -> None:
    if not _ENABLED:
        return
    try:
        _writer_for_this_process().put(row)
    except Exception:
        pass


def _writer_for_this_process() -> "_Writer":
    global _writer
    if _writer is None or _writer.pid != os.getpid():
        with _writer_lock:
            if _writer is None or _writer.pid != os.getpid():
                # A forked Celery child gets its own writer thread.
                _writer = _Writer()
    return _writer
