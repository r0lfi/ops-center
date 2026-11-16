"""AI Traffic Monitor on real PostgreSQL (schema at head): de-duplication of
the worker's and the capture's observations, collector auth, the read views,
export, PCAP hand-off and coverage reporting.

    BOARD_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_board_test?host=/path/to/socket' pytest tests/test_ai_traffic_pg.py
"""
import asyncio
import json
import os
import time
import uuid
from unittest.mock import patch

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.deps import get_current_user
from app.api.routes.ai_traffic import collector_token
from app.core.config import get_settings
from app.db.session import get_db
from app.main import app
from app.models.user import User

URL = os.environ.get("BOARD_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_board_test" not in URL, reason="needs BOARD_TEST_DATABASE_URL for ops_board_test")
TOKEN = "collector-test-secret"


def head(node="docker-host-01"):
    return {"X-AI-Traffic-Token": collector_token(TOKEN, node), "X-AI-Traffic-Node": node}


HEAD = head()


def scenario(body):
    async def run():
        engine = create_async_engine(URL)
        assert engine.url.database == "ops_board_test"
        maker = async_sessionmaker(engine, expire_on_commit=False)
        async with maker() as db:
            for table in ("ai_traffic_events", "ai_trace_spans", "ai_traffic_sources", "ai_traffic_captures"):
                await db.execute(text(f"DELETE FROM {table}"))
            await db.execute(text("DELETE FROM users WHERE username LIKE 'aitm-%'"))
            users = {role: User(username=f"aitm-{role}", password_hash="x", role=role, is_active=True) for role in ("admin", "operator", "viewer")}
            db.add_all(users.values())
            await db.commit()
            current = {"user": users["admin"]}

            async def database():
                async with maker() as session:
                    yield session

            app.dependency_overrides[get_db] = database
            app.dependency_overrides[get_current_user] = lambda: current["user"]
            settings = get_settings()
            try:
                with patch.object(settings, "ai_traffic_ingest_token", TOKEN):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                        await body(client, db, users, current)
            finally:
                app.dependency_overrides.clear()
        await engine.dispose()
    asyncio.run(run())


async def app_rows(db, rows):
    """What the AI worker's writer does (worker_ai/ai/netlog.py)."""
    merged = (await db.execute(text("SELECT ai_traffic_ingest(CAST(:r AS jsonb))"), {"r": json.dumps(rows)})).scalar()
    await db.commit()
    return merged


def test_worker_and_capture_observations_of_one_connection_become_one_event():
    async def body(client, db, users, current):
        t0 = time.time()
        trace = uuid.uuid4().hex
        await app_rows(db, [
            {"type": "span", "span_id": "a" * 16, "trace_id": trace, "kind": "agent", "name": "Monitoring", "agent_slug": "monitoring",
             "node": "docker-host-01", "ts": t0, "status": "running", "attributes": {}},
            {"type": "event", "source": "app", "obs_id": "app1", "ts": t0, "node": "docker-host-01", "kind": "http",
             "trace_id": trace, "span_id": "a" * 16, "agent_slug": "monitoring", "tool": "web_fetch", "provider": "mistral",
             "model": "mistral-large", "src_ip": "203.0.113.5", "src_port": 40001, "dst_ip": "1.2.3.4", "dst_port": 443,
             "dst_host": "api.mistral.ai", "protocol": "https", "method": "POST", "path": "/v1/chat/completions",
             "status_code": 200, "bytes_sent": 900, "bytes_recv": 4000, "outcome": "ok", "duration_ms": 800},
        ])
        # The capture reports the same socket: wire bytes, host PID, TLS SNI.
        r = await client.post("/api/ai-traffic/ingest", headers=HEAD, json={"node": "docker-host-01", "source": {"conntrack": {"listening": True, "acct": True}}, "events": [
            {"type": "event", "obs_id": "cap1", "ts": t0 + 0.01, "kind": "tcp", "src_ip": "203.0.113.5", "src_port": 40001,
             "dst_ip": "1.2.3.4", "dst_port": 443, "dst_host": "api.mistral.ai", "protocol": "tls", "pid": 4242,
             "process": "celery worker", "bytes_sent": 1500, "bytes_recv": 6000, "outcome": "ok", "detail": {"tls_sni": "api.mistral.ai"}},
        ]})
        assert r.status_code == 200 and r.json() == {"stored": 1, "merged": 1}
        rows = (await db.execute(text("SELECT * FROM ai_traffic_events"))).mappings().all()
        assert len(rows) == 1
        e = rows[0]
        assert sorted(e["sources"]) == ["app", "capture"] and len(e["observations"]) == 2
        assert e["agent_slug"] == "monitoring" and e["tool"] == "web_fetch" and e["protocol"] == "https"
        assert e["bytes_sent"] == 1500 and e["bytes_recv"] == 6000 and e["pid"] == 4242
        assert e["detail"]["tls_sni"] == "api.mistral.ai"
        # A later update of the same capture observation (connection closed) merges again, no new row.
        r = await client.post("/api/ai-traffic/ingest", headers=HEAD, json={"node": "docker-host-01", "events": [
            {"type": "event", "obs_id": "cap1", "ts": t0 + 0.01, "ended_at": t0 + 2, "kind": "tcp", "src_ip": "203.0.113.5",
             "src_port": 40001, "dst_ip": "1.2.3.4", "dst_port": 443, "bytes_sent": 1600, "bytes_recv": 6100, "outcome": "ok"}]})
        assert (await db.execute(text("SELECT count(*), max(bytes_recv) FROM ai_traffic_events"))).one() == (1, 6100)
        # Detail view keeps every original observation and the span chain.
        current["user"] = users["operator"]
        detail = (await client.get(f"/api/ai-traffic/events/{e['id']}")).json()
        assert len(detail["event"]["observations"]) == 2 and detail["span_chain"][0]["kind"] == "agent"
    scenario(body)


def test_failure_classes_stay_distinct_and_a_timeout_is_not_a_block():
    async def body(client, db, users, current):
        t0 = time.time()
        await app_rows(db, [
            {"type": "event", "source": "app", "obs_id": "t", "ts": t0, "node": "n1", "kind": "http", "dst_ip": "5.5.5.5", "dst_port": 443,
             "dst_host": "slow.example", "outcome": "timeout", "reason": "ReadTimeout", "agent_slug": "general"},
            {"type": "event", "source": "app", "obs_id": "f", "ts": t0, "node": "n1", "kind": "http", "dst_ip": "6.6.6.6", "dst_port": 443,
             "dst_host": "forbidden.example", "status_code": 403, "outcome": "remote_reject", "agent_slug": "general"},
            {"type": "event", "source": "app", "obs_id": "a", "ts": t0, "node": "n1", "kind": "access", "outcome": "ai_access_control",
             "reason": "not in allowed_hosts", "rule_id": "agent.allowed_hosts", "agent_slug": "linux"},
        ])
        # The capture sees the timed-out connection answered by an admin-prohibited ICMP: the stronger evidence wins.
        await client.post("/api/ai-traffic/ingest", headers=head("n1"), json={"events": [
            {"type": "event", "obs_id": "c", "ts": t0 + 1, "kind": "tcp", "src_ip": "203.0.113.5", "dst_ip": "5.5.5.5", "dst_port": 443,
             "outcome": "firewall_block", "reason": "ICMP 3/13 from 198.51.100.1"}]})
        current["user"] = users["operator"]
        blocked = (await client.get("/api/ai-traffic/blocked?window=1h")).json()
        assert blocked["counts"] == {"firewall_block": 1, "remote_reject": 1, "ai_access_control": 1}
        failed = (await client.get("/api/ai-traffic/events?window=1h&status=failed")).json()
        assert [e["dst_host"] for e in failed["events"]] == ["forbidden.example"]
        search = (await client.get("/api/ai-traffic/events?window=1h&q=forbid")).json()
        assert search["total"] == 1
    scenario(body)


def test_dns_seen_by_worker_and_on_the_wire_is_one_lookup():
    async def body(client, db, users, current):
        t0 = time.time()
        await app_rows(db, [{"type": "event", "source": "app", "obs_id": "d1", "ts": t0, "node": "n1", "kind": "dns",
                             "dst_host": "API.Mistral.ai", "outcome": "ok", "agent_slug": "general", "detail": {"answers": ["1.2.3.4"]}}])
        await client.post("/api/ai-traffic/ingest", headers=head("n1"), json={"events": [
            {"type": "event", "obs_id": "d2", "ts": t0 + 0.2, "kind": "dns", "dst_ip": "198.51.100.53", "dst_port": 53,
             "dst_host": "api.mistral.ai", "outcome": "ok", "detail": {"rcode": "NOERROR"}}]})
        rows = (await db.execute(text("SELECT sources, agent_slug, dst_ip FROM ai_traffic_events"))).all()
        assert len(rows) == 1 and sorted(rows[0][0]) == ["app", "capture"] and rows[0][1] == "general" and rows[0][2] == "198.51.100.53"
    scenario(body)


def test_collector_needs_its_token_and_speaks_only_for_capture():
    async def body(client, db, users, current):
        assert (await client.post("/api/ai-traffic/ingest", json={"events": []})).status_code == 401
        assert (await client.post("/api/ai-traffic/ingest", headers={**HEAD, "X-AI-Traffic-Token": "wrong"}, json={})).status_code == 401
        # Node 01's token does not let it speak for node 02.
        assert (await client.post("/api/ai-traffic/ingest", headers={**HEAD, "X-AI-Traffic-Node": "docker-host-02"}, json={})).status_code == 401
        r = await client.post("/api/ai-traffic/ingest", headers=HEAD, json={"events": [
            {"type": "event", "source": "app", "node": "other", "obs_id": "x", "ts": time.time(), "kind": "tcp", "agent_slug": "forged",
             "trace_id": "f" * 32, "tool": "=cmd|' /C calc'!A0", "model": "forged"},
            {"type": "span", "span_id": "b" * 16}]})
        assert r.json()["stored"] == 1
        row = (await db.execute(text("SELECT sources, node, agent_slug, trace_id, tool, model FROM ai_traffic_events"))).one()
        assert row == (["capture"], "docker-host-01", None, None, None, None)
        with patch.object(get_settings(), "ai_traffic_ingest_token", ""):
            assert (await client.post("/api/ai-traffic/ingest", headers=HEAD, json={})).status_code == 503
    scenario(body)


def test_detail_views_need_operator_and_coverage_reports_gaps():
    async def body(client, db, users, current):
        await app_rows(db, [{"type": "event", "source": "app", "obs_id": "o", "ts": time.time(), "node": "docker-host-02", "kind": "http",
                             "dst_host": "x", "outcome": "ok"}])
        await db.execute(text("INSERT INTO ai_traffic_sources (name, kind, node, last_seen, stats) VALUES "
                              "('app:docker-host-02', 'app', 'docker-host-02', now(), '{}')"))
        await db.commit()
        current["user"] = users["viewer"]
        overview = (await client.get("/api/ai-traffic/overview?window=1h")).json()
        assert overview["totals"]["requests"] == 1
        coverage = {(c["node"], c["area"].split(" (")[0]): c["status"] for c in overview["coverage"]}
        assert coverage[("docker-host-02", "Passive network capture")] == "missing"
        assert coverage[(None, "Firewall drop logs")] == "missing"
        for path in ("/api/ai-traffic/events", "/api/ai-traffic/flow", "/api/ai-traffic/traces", "/api/ai-traffic/export"):
            assert (await client.get(path)).status_code == 403, path
        current["user"] = users["operator"]
        assert (await client.get("/api/ai-traffic/flow?window=1h")).json()["links"][0]["destination"] == "x"
        assert (await client.put("/api/ai-traffic/settings", json={"retention_days": 7, "capture_retention_hours": 12})).status_code == 403
    scenario(body)


def test_export_and_trace_timeline():
    async def body(client, db, users, current):
        t0 = time.time()
        task = uuid.uuid4()
        trace = task.hex
        await app_rows(db, [
            {"type": "span", "span_id": "1" * 16, "trace_id": trace, "task_id": str(task), "kind": "agent", "name": "Coordinator",
             "agent_slug": "coordinator", "node": "n1", "ts": t0, "ended_at": t0 + 5, "duration_ms": 5000, "status": "ok", "attributes": {}},
            {"type": "span", "span_id": "2" * 16, "parent_span_id": "1" * 16, "trace_id": trace, "task_id": str(task), "kind": "tool",
             "name": "web_search", "agent_slug": "coordinator", "node": "n1", "ts": t0 + 1, "ended_at": t0 + 2, "duration_ms": 1000,
             "status": "ok", "attributes": {"gen_ai.tool.name": "web_search"}},
            {"type": "event", "source": "app", "obs_id": "e", "ts": t0 + 1.1, "node": "n1", "kind": "http", "trace_id": trace,
             "span_id": "2" * 16, "task_id": str(task), "agent_slug": "coordinator", "tool": "web_search", "dst_host": "html.duckduckgo.com",
             "dst_port": 443, "method": "GET", "path": "/html/", "status_code": 200, "outcome": "ok"},
        ])
        current["user"] = users["operator"]
        listed = (await client.get("/api/ai-traffic/traces?window=1h")).json()["traces"]
        assert listed[0]["trace_id"] == trace and listed[0]["events"] == 1 and listed[0]["root_agent"] == "coordinator"
        detail = (await client.get(f"/api/ai-traffic/traces/{trace}")).json()
        assert [s["kind"] for s in detail["spans"]] == ["agent", "tool"] and detail["events"][0]["span_id"] == "2" * 16
        await app_rows(db, [{"type": "event", "source": "app", "obs_id": "x", "ts": t0, "node": "n1", "kind": "access",
                             "outcome": "ai_access_control", "tool": "=HYPERLINK(\"http://x\")", "reason": "-2+3"}])
        formula = (await client.get("/api/ai-traffic/export?format=csv&window=1h&kind=access")).text
        assert "'=HYPERLINK" in formula and "'-2+3" in formula
        csv_body = (await client.get("/api/ai-traffic/export?format=csv&window=1h&kind=http")).text.splitlines()
        assert csv_body[0].startswith("id,ts,") and "html.duckduckgo.com" in csv_body[1]
        exported = (await client.get("/api/ai-traffic/export?format=json&window=1h&agent=coordinator")).json()
        assert len(exported["events"]) == 1
    scenario(body)


def test_pcap_capture_round_trip_is_admin_only_and_bounded():
    async def body(client, db, users, current):
        await client.post("/api/ai-traffic/ingest", headers=HEAD, json={"events": []})  # collector heartbeat
        current["user"] = users["operator"]
        assert (await client.post("/api/ai-traffic/captures", json={"node": "docker-host-01"})).status_code == 403
        current["user"] = users["admin"]
        assert (await client.post("/api/ai-traffic/captures", json={"node": "nowhere"})).status_code == 409
        assert (await client.post("/api/ai-traffic/captures", json={"node": "docker-host-01", "seconds": 999})).status_code == 422
        created = (await client.post("/api/ai-traffic/captures", json={"node": "docker-host-01", "seconds": 10, "max_mb": 2})).json()
        assert (await client.post("/api/ai-traffic/captures", json={"node": "docker-host-01"})).status_code == 409
        pending = (await client.get("/api/ai-traffic/collector/captures", headers=HEAD)).json()["captures"]
        assert pending == [{"id": created["id"], "seconds": 10, "max_bytes": 2 * 1024 * 1024}]
        assert (await client.get("/api/ai-traffic/collector/captures", headers=HEAD)).json()["captures"] == []
        pcap = b"\xd4\xc3\xb2\xa1" + b"\x00" * 20
        done = await client.post(f"/api/ai-traffic/collector/captures/{created['id']}", headers={**HEAD, "X-Capture-Status": "done",
                                 "X-Capture-Packets": "0"}, content=pcap)
        assert done.status_code == 200
        download = await client.get(f"/api/ai-traffic/captures/{created['id']}/download")
        assert download.status_code == 200 and download.content == pcap
        assert (await client.get("/api/ai-traffic/captures")).json()["captures"][0]["status"] == "done"
    scenario(body)


def test_failed_connect_without_worker_port_merges_with_the_wire_observation():
    """Seen on docker-host-02: a rejected connect has no local port in the worker; the capture
    reports the SYN first as pending, then the ICMP reject. One row, strongest evidence wins."""
    async def body(client, db, users, current):
        t0 = time.time()
        await app_rows(db, [{"type": "event", "source": "app", "obs_id": "fail", "ts": t0, "node": "n1", "kind": "http",
                             "agent_slug": "linux", "dst_ip": "198.51.100.45", "dst_port": 1, "dst_host": "198.51.100.45",
                             "outcome": "connect_error", "reason": "No route to host"}])
        for outcome, reason in (("ok", None), ("firewall_block", "ICMP 3/13 (administratively prohibited) from 198.51.100.45")):
            await client.post("/api/ai-traffic/ingest", headers=head("n1"), json={"events": [
                {"type": "event", "obs_id": "syn", "ts": t0 + 0.002, "kind": "tcp", "src_ip": "203.0.113.5", "src_port": 38430,
                 "dst_ip": "198.51.100.45", "dst_port": 1, "outcome": outcome, "reason": reason}]})
        rows = (await db.execute(text("SELECT sources, agent_slug, src_port, outcome FROM ai_traffic_events"))).all()
        assert len(rows) == 1
        assert sorted(rows[0][0]) == ["app", "capture"] and rows[0][1:] == ("linux", 38430, "firewall_block")
    scenario(body)


def test_live_map_groups_noise_keeps_internal_off_the_world_map_and_is_operator_only():
    async def body(client, db, users, current):
        insert = text(
            "INSERT INTO ai_traffic_events (ts, node, kind, sources, obs_keys, agent_slug, model, provider, container, process, "
            "src_ip, src_port, dst_ip, dst_port, dst_host, protocol, outcome, bytes_sent, bytes_recv) VALUES "
            "(now() - (:age || ' seconds')::interval, 'docker-host-01', :kind, :sources, ARRAY[:key], :agent, :model, :provider, "
            ":container, :process, '203.0.113.18', :sport, :dst, :port, :host, :proto, :outcome, :sent, :recv)")
        base = dict(age="5", kind="tcp", sources=["capture"], agent=None, model=None, provider=None, container="ops-center-ai-worker",
                    process="celery", dst="198.51.100.45", port=6379, host=None, proto="tcp", outcome="ok", sent=100, recv=200)
        for i in range(400):  # Celery heartbeat noise
            await db.execute(insert, {**base, "key": f"c{i}", "sport": 40000 + i})
        await db.execute(insert, {**base, "key": "a1", "sport": 1, "kind": "http", "sources": ["app", "capture"], "agent": "developer",
                                  "model": "m-large", "provider": "mistral", "process": "python", "dst": "8.8.8.8", "port": 443,
                                  "host": "api.example.com", "proto": "https"})
        await db.execute(insert, {**base, "key": "b1", "sport": 2, "kind": "access", "sources": ["app"], "agent": "general",
                                  "dst": None, "port": None, "host": "blocked.example", "proto": None, "outcome": "ai_access_control",
                                  "sent": None, "recv": None})
        await db.execute(insert, {**base, "key": "l1", "sport": 3, "dst": "127.0.0.1", "port": 8000})
        await db.commit()
        with patch("app.services.traffic_watch._geolocate", return_value=(50.11, 8.68, "Frankfurt", "Germany")) as geo:
            data = (await client.get("/api/ai-traffic/map?window=1h")).json()
        by = {(g["dst_ip"], g["dst_port"]): g for g in data["groups"]}
        celery = by[("198.51.100.45", 6379)]
        assert celery["count"] == 400 and celery["bytes_sent"] == 40000 and celery["src_count"] == 1
        assert celery["scope"] == "internal" and celery["geo"] is None and celery["category"] == "system"
        assert celery["service"] == "Redis" and celery["direction"] == "outbound"
        external = by[("8.8.8.8", 443)]
        assert external["scope"] == "external" and external["geo"]["country"] == "Germany" and external["category"] == "ai"
        assert external["agent"] == "developer" and external["dst_host"] == "api.example.com"
        blocked = by[(None, None)]
        assert blocked["status"] == "blocked" and blocked["scope"] == "unknown" and blocked["geo"] is None
        assert by[("127.0.0.1", 8000)]["scope"] == "local"
        # Only the public address was looked up.
        assert [c.args[0] for c in geo.call_args_list] == ["8.8.8.8"]
        assert data["countries"] == [{"country": "Germany", "count": 1, "bytes": 300, "problems": 0}]
        ai_only = (await client.get("/api/ai-traffic/map?window=1h&category=ai")).json()["groups"]
        assert {g["agent"] for g in ai_only} == {"developer", "general"}
        blocked_only = (await client.get("/api/ai-traffic/map?window=1h&status=blocked")).json()["groups"]
        assert [g["dst_host"] for g in blocked_only] == ["blocked.example"]
        current["user"] = users["viewer"]
        assert (await client.get("/api/ai-traffic/map")).status_code == 403
    scenario(body)
