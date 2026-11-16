"""AI Traffic Monitor instrumentation: passive, attributed, never changes a request."""
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest

from worker_ai.ai import netlog


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = 403 if self.path.startswith("/deny") else 200
        body = b"x" * 1000
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.do_GET()

    def log_message(self, *args):
        pass


@pytest.fixture
def server():
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


@pytest.fixture
def events(monkeypatch):
    rows = []
    monkeypatch.setattr(netlog, "_ENABLED", True)
    monkeypatch.setattr(netlog, "_put", rows.append)
    netlog._instrument(httpx)
    return rows


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_request_is_recorded_with_agent_tool_trace_and_socket(server, events):
    task = "7f0c2a52-0d55-4a8e-9f55-1b0e1a3c4d5e"
    with netlog.span("agent", "Monitoring", agent_slug="monitoring", task_id=task):
        with netlog.span("tool", "web_fetch", tool="web_fetch"):
            response = httpx.post(server + "/v1/chat?key=SECRET", content=b"hello world")
    assert response.status_code == 200 and response.content == b"x" * 1000  # unchanged for the caller
    http = [e for e in events if e.get("kind") == "http"]
    assert len(http) == 1
    e = http[0]
    assert e["agent_slug"] == "monitoring" and e["tool"] == "web_fetch"
    assert e["trace_id"] == task.replace("-", "") and e["task_id"] == task
    assert e["path"] == "/v1/chat"  # query string (and its secret) dropped
    assert e["method"] == "POST" and e["status_code"] == 200 and e["outcome"] == "ok"
    assert e["bytes_sent"] == 11 and e["bytes_recv"] == 1000
    assert e["src_ip"] == "127.0.0.1" and isinstance(e["src_port"], int) and e["dst_port"] == int(server.rsplit(":", 1)[1])
    spans = [s for s in events if s.get("type") == "span"]
    tool_spans = [s for s in spans if s["kind"] == "tool" and s["status"] == "ok"]
    agent_spans = [s for s in spans if s["kind"] == "agent" and s["status"] == "ok"]
    assert tool_spans and agent_spans and tool_spans[0]["parent_span_id"] == agent_spans[0]["span_id"]
    assert e["span_id"] == tool_spans[0]["span_id"]


def test_remote_reject_and_refused_connection_are_classified_not_called_blocks(server, events):
    assert httpx.get(server + "/deny").status_code == 403
    with pytest.raises(httpx.ConnectError):
        httpx.get(f"http://127.0.0.1:{_free_port()}/")
    http = [e for e in events if e.get("kind") == "http"]
    assert http[0]["outcome"] == "remote_reject" and http[0]["reason"] == "HTTP 403"
    assert http[1]["outcome"] == "connect_error" and "refused" in http[1]["reason"]
    assert http[1]["status_code"] is None and http[1]["bytes_recv"] is None


def test_timeouts_and_dns_failures_have_their_own_class():
    assert netlog.classify(httpx.ReadTimeout("timed out"))[0] == "timeout"
    exc = httpx.ConnectError("[Errno -2] Name or service not known")
    assert netlog.classify(exc)[0] == "dns_error"
    tls = httpx.ConnectError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
    assert netlog.classify(tls)[0] == "tls_error"
    assert netlog.classify(httpx.ConnectError("[Errno 113] No route to host"))[0] == "connect_error"


def test_secret_looking_path_segments_are_masked():
    assert netlog.mask_path("/bot123456:ABCdefGHIjklMNOpqrSTUvwxYZ12/send?x=1") == "/***/send"
    assert netlog.mask_path("/v1/chat/completions") == "/v1/chat/completions"


def test_access_decisions_carry_the_current_agent(events):
    with netlog.span("agent", "Linux", agent_slug="linux"):
        netlog.access("not in allowed_hosts", tool="restart_service", host="db-01", rule="agent.allowed_hosts")
    access = [e for e in events if e.get("kind") == "access"]
    assert access[0]["agent_slug"] == "linux" and access[0]["outcome"] == "ai_access_control"
    assert access[0]["rule_id"] == "agent.allowed_hosts" and access[0]["dst_host"] == "db-01"


def test_dns_lookups_are_recorded_and_failures_still_raise(events, monkeypatch):
    monkeypatch.setattr(netlog, "_original_getaddrinfo", lambda *a, **k: (_ for _ in ()).throw(socket.gaierror(-2, "Name or service not known")))
    with pytest.raises(socket.gaierror):
        netlog._getaddrinfo("nothing.invalid", 443)
    dns = [e for e in events if e.get("kind") == "dns"]
    assert dns[0]["dst_host"] == "nothing.invalid" and dns[0]["outcome"] == "dns_error"


def test_full_queue_drops_and_counts_instead_of_blocking(monkeypatch):
    monkeypatch.setattr(netlog, "QUEUE_SIZE", 2)
    writer = netlog._Writer.__new__(netlog._Writer)
    import queue
    writer.queue = queue.Queue(maxsize=2)
    writer.stats = {"emitted": 0, "written": 0, "dropped": 0, "failed_batches": 0, "merged": 0}
    for _ in range(5):
        writer.put({"type": "event"})
    assert writer.stats == {"emitted": 5, "written": 0, "dropped": 3, "failed_batches": 0, "merged": 0}


def test_nothing_is_recorded_until_installed(monkeypatch):
    calls = []
    monkeypatch.setattr(netlog, "_ENABLED", False)
    monkeypatch.setattr(netlog, "_Writer", lambda: calls.append(1))
    netlog._put({"type": "event"})
    assert calls == []
