"""Lifecycle, recovery, RBAC and delivery tests against an isolated PostgreSQL database."""

import asyncio
import os
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, text, delete, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool
from app.models.incidents import IMSettings, Incident, IMCondition, IMEvent, IMDelivery
from app.services import incidents as im, incident_watch as watch
from app.schemas.incidents import IMConfig, IMDecision

URL = os.environ.get("OPS_IM_TEST_URL", "")
requires_db = pytest.mark.skipif(
    not URL, reason="requires isolated ops_im_test database"
)


def alert(name="DiskWarning", severity="warning", **labels):
    return {
        "labels": {
            "alertname": name,
            "hostname": "server.example",
            "mountpoint": "/data",
            "severity": severity,
            **labels,
        },
        "status": {"state": "active"},
        "annotations": {"summary": "Synthetic capacity warning"},
    }


def test_disk_severity_and_shared_mounts_use_stable_identity():
    rows = im.resource_candidates(
        [alert(), alert("DiskCritical", "critical"), alert("InodeWarning")]
    )
    assert len(rows) == 1 and rows[0]["severity"] == "critical"
    rows = im.resource_candidates(
        [
            alert(hostname="a", fstype="nfs", device="nas:/share"),
            alert(hostname="b", fstype="nfs", device="nas:/share"),
        ]
    )
    assert len(rows) == 1
    assert len(im.resource_candidates([alert(), alert(mountpoint="/other")])) == 2
    assert (
        len(
            im.resource_candidates([alert("HighCPU"), alert("CriticalCPU", "critical")])
        )
        == 1
    )


def test_routing_filters_do_not_depend_on_severity_in_identity():
    item = SimpleNamespace(**im.resource_candidates([alert()])[0])
    assert im.selected(IMConfig(), item)
    assert not im.selected(IMConfig(categories=["authentication"]), item)
    assert not im.selected(IMConfig(excluded_rules=["disk_capacity"]), item)
    assert not im.selected(IMConfig(excluded_resources=[item.resource]), item)


def test_explicit_trusted_ip_validation_and_attack_signals():
    from app.schemas.traffic_settings import TrafficSettingsConfig
    from app.services.traffic_auth import candidate, origin_reason
    from app.services.traffic_security import detect

    config = TrafficSettingsConfig(trusted_ips=["2001:db8:0:0::1", "2001:db8::1"])
    assert config.trusted_ips == ["2001:db8::1"]
    for value in ("not-an-ip", "0.0.0.0/0", "https://example.com"):
        with pytest.raises(ValueError):
            TrafficSettingsConfig(trusted_ips=[value])
    policy = {
        "countries": [],
        "addresses": [],
        "trusted_ips": ["203.0.113.10"],
        "ssh_failure_sources": ["ssh"],
    }
    event = dict(
        ts=1000,
        ip="203.0.113.10",
        country="Germany",
        kind="ssh",
        signal="auth_success",
        domain="server.example",
        source="ssh",
    )
    assert candidate(event, policy) is None
    assert (
        origin_reason(event["ip"], None, policy, "ssh")
        == "Explicitly trusted IP address"
    )
    assert candidate({**event, "ip": "203.0.113.11"}, policy)["rule"] == "foreign_ssh"
    assert (
        candidate({**event, "kind": "http", "signal": "auth_failure"}, policy)["rule"]
        == "login_rejected"
    )
    probes = [
        dict(
            ts=1000 + i,
            ip=event["ip"],
            domain="server.example",
            kind="http",
            signal="probe",
            status=404,
        )
        for i in range(25)
    ]
    assert any(a["rule"] == "path_scan" for a in detect(probes, {}, 1100))


@pytest_asyncio.fixture
async def env(monkeypatch):
    assert (
        "/ops_im_test" in URL and "ops_im_test" == URL.split("?")[0].rsplit("/", 1)[-1]
    ), "Refusing application database"
    engine = create_async_engine(URL, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db, db.begin():
        for model in (IMDelivery, IMEvent, IMCondition, Incident):
            await db.execute(delete(model))
        state = await db.get(IMSettings, 1)
        state.value = {}
        state.revision = 0
    monkeypatch.setattr(watch, "async_session_factory", factory)
    monkeypatch.setattr(
        watch, "admin_rooms", AsyncMock(return_value={"synthetic-room"})
    )
    monkeypatch.setattr(
        watch,
        "get_settings",
        lambda: SimpleNamespace(
            mcp_public_url="https://ops.example/mcp", talk_notifications_enabled=True
        ),
    )
    monkeypatch.setattr(
        watch,
        "traffic_config",
        AsyncMock(return_value=SimpleNamespace(notify_authentication=True)),
    )
    send = AsyncMock()
    monkeypatch.setattr(watch, "send_talk", send)

    async def ingest(items=None, now=None, complete=True, config=None):
        async with factory() as db, db.begin():
            await db.execute(text("SELECT pg_advisory_xact_lock(738143)"))
            await im.reconcile(
                db,
                "alertmanager",
                im.resource_candidates([alert()]) if items is None else items,
                now=now or im.utcnow(),
                complete=complete,
                config=config or IMConfig(),
                rooms={"synthetic-room"},
            )

    async def rows(model):
        async with factory() as db:
            return list((await db.scalars(select(model).order_by(model.id))).all())

    async def complete():
        item = (await rows(Incident))[0]
        async with factory() as db, db.begin():
            await im.decide(
                db,
                item.id,
                IMDecision(revision=item.revision, status="completed", note="Handled"),
                SimpleNamespace(username="operator"),
            )

    yield SimpleNamespace(
        db=factory, ingest=ingest, rows=rows, complete=complete, send=send
    )
    await engine.dispose()


@requires_db
@pytest.mark.asyncio
async def test_many_repeats_parallel_nodes_and_critical_after_completion(env):
    t = im.utcnow()
    await asyncio.gather(*[env.ingest(now=t) for _ in range(8)])
    await env.complete()
    for i in range(100):
        await env.ingest(
            im.resource_candidates([alert("DiskCritical", "critical")]),
            now=t + timedelta(minutes=i),
        )
    rows = await env.rows(Incident)
    assert (
        len(rows) == 1
        and rows[0].status == "completed"
        and rows[0].severity == "critical"
    )
    assert len(await env.rows(IMDelivery)) == 1
    assert len(await env.rows(IMEvent)) == 2


@requires_db
@pytest.mark.asyncio
async def test_confirmed_recovery_then_new_failure_creates_one_new_im(env):
    t = im.utcnow()
    await env.ingest(now=t)
    await env.complete()
    for minute in range(1, 33):
        await env.ingest([], now=t + timedelta(minutes=minute))
    await env.ingest(now=t + timedelta(minutes=33))
    await env.ingest(now=t + timedelta(minutes=34))
    rows = await env.rows(Incident)
    assert [r.status for r in rows] == ["completed", "new"]
    assert len(await env.rows(IMDelivery)) == 2


@requires_db
@pytest.mark.asyncio
@pytest.mark.parametrize("outage", ["unknown", "restart_gap", "brief_recovery"])
async def test_absence_without_confirmed_recovery_does_not_reopen(env, outage):
    t = im.utcnow()
    await env.ingest(now=t)
    await env.complete()
    await env.ingest([], now=t + timedelta(minutes=1))
    if outage == "unknown":
        for minute in range(2, 40):
            await env.ingest([], now=t + timedelta(minutes=minute), complete=False)
        await env.ingest(now=t + timedelta(minutes=40))
    elif outage == "restart_gap":
        await env.ingest(now=t + timedelta(days=2))
    else:
        await env.ingest(now=t + timedelta(minutes=2))
    assert len(await env.rows(Incident)) == 1


@requires_db
@pytest.mark.asyncio
async def test_recovery_does_not_duplicate_open_im(env):
    t = im.utcnow()
    await env.ingest(now=t)
    for minute in range(1, 35):
        await env.ingest([], now=t + timedelta(minutes=minute))
    await env.ingest(now=t + timedelta(minutes=35))
    assert len(await env.rows(Incident)) == 1


@requires_db
@pytest.mark.asyncio
async def test_notifications_only_closes_on_recovery_and_notifies_recurrence(env):
    config = IMConfig(workflow_enabled=False)
    t = im.utcnow()
    for minute in range(3):
        await env.ingest(now=t + timedelta(minutes=minute), config=config)
    for minute in range(3, 36):
        await env.ingest([], now=t + timedelta(minutes=minute), config=config)
    rows = await env.rows(Incident)
    assert [r.status for r in rows] == ["completed"] and rows[0].updated_by == "monitor"
    # Nobody completed it by hand, yet the next occurrence notifies again.
    await env.ingest(now=t + timedelta(minutes=36), config=config)
    await env.ingest(now=t + timedelta(minutes=37), config=config)
    assert [r.status for r in await env.rows(Incident)] == ["completed", "new"]
    assert len(await env.rows(IMDelivery)) == 2


@requires_db
@pytest.mark.asyncio
async def test_notifications_only_delivery_is_a_plain_alert(env):
    async with env.db() as db, db.begin():
        state = await db.get(IMSettings, 1)
        state.value = {"workflow_enabled": False}
    await env.ingest(config=IMConfig(workflow_enabled=False))
    assert await watch.deliver_once()
    message = env.send.await_args.args[1]
    assert message.startswith("🔔 WARNING") and "IM-" not in message
    assert "Acknowledge" not in message


@requires_db
@pytest.mark.asyncio
async def test_muted_creation_is_never_replayed_when_enabled(env):
    await env.ingest(config=IMConfig(talk_enabled=False))
    await env.ingest(config=IMConfig(talk_enabled=True))
    assert len(await env.rows(Incident)) == 1
    assert not await env.rows(IMDelivery)


@requires_db
@pytest.mark.asyncio
async def test_delivery_claim_survives_parallel_workers_and_restart(env):
    await env.ingest()
    await asyncio.gather(
        watch.deliver_once(), watch.deliver_once(), watch.deliver_once()
    )
    await watch.deliver_once()
    env.send.assert_awaited_once()
    assert (await env.rows(IMDelivery))[0].status == "sent"
    assert "/incidents/" in env.send.call_args.args[1]


@requires_db
@pytest.mark.asyncio
async def test_unknown_delivery_has_no_automatic_retry(env):
    await env.ingest()
    env.send.side_effect = TimeoutError("synthetic ambiguous acknowledgement")
    await watch.deliver_once()
    await watch.deliver_once()
    env.send.assert_awaited_once()
    assert (await env.rows(IMDelivery))[0].status == "unknown"


def _refused():
    return httpx.ConnectError("synthetic connection refused")


def _unavailable():
    request = httpx.Request("POST", "https://talk.example/")
    return httpx.HTTPStatusError(
        "synthetic maintenance mode",
        request=request,
        response=httpx.Response(503, request=request),
    )


async def _age_claim(env, **age):
    async with env.db() as db, db.begin():
        row = (await db.scalars(select(IMDelivery))).one()
        row.claimed_at = im.utcnow() - timedelta(**age)


@requires_db
@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [_refused, _unavailable])
async def test_send_that_never_reached_talk_is_retried(env, failure):
    await env.ingest()
    env.send.side_effect = failure()
    assert not await watch.deliver_once()
    assert (await env.rows(IMDelivery))[0].status == "pending"
    # Backed off: an immediate second round does not hammer Talk.
    assert not await watch.deliver_once()
    env.send.assert_awaited_once()
    await _age_claim(env, minutes=3)
    env.send.side_effect = None
    assert await watch.deliver_once()
    assert env.send.await_count == 2
    row = (await env.rows(IMDelivery))[0]
    assert row.status == "sent" and row.sent_at is not None


@requires_db
@pytest.mark.asyncio
async def test_retry_stops_after_the_window(env):
    await env.ingest()
    async with env.db() as db, db.begin():
        incident = (await db.scalars(select(Incident))).one()
        incident.created_at = im.utcnow() - timedelta(hours=7)
    env.send.side_effect = _refused()
    await watch.deliver_once()
    assert (await env.rows(IMDelivery))[0].status == "failed"
    await _age_claim(env, minutes=3)
    await watch.deliver_once()
    env.send.assert_awaited_once()


@requires_db
@pytest.mark.asyncio
async def test_crashed_sender_is_not_reclaimed(env):
    await env.ingest()
    async with env.db() as db, db.begin():
        row = (await db.scalars(select(IMDelivery))).one()
        row.status = "sending"
        row.claimed_at = im.utcnow() - timedelta(minutes=2)
    await watch.deliver_once()
    env.send.assert_not_awaited()
    assert (await env.rows(IMDelivery))[0].status == "unknown"


@requires_db
@pytest.mark.asyncio
@pytest.mark.parametrize("stop", ["completed", "settings", "room_removed"])
async def test_unsent_notice_rechecks_authority_and_policy(env, monkeypatch, stop):
    await env.ingest()
    if stop == "completed":
        await env.complete()
    elif stop == "room_removed":
        monkeypatch.setattr(watch, "admin_rooms", AsyncMock(return_value=set()))
    else:
        async with env.db() as db, db.begin():
            row = await db.get(IMSettings, 1)
            row.value = {"talk_enabled": False}
    await watch.deliver_once()
    env.send.assert_not_awaited()
    assert (await env.rows(IMDelivery))[0].status == "suppressed"


@requires_db
@pytest.mark.asyncio
async def test_api_permissions_revision_history_and_no_reopen(env, monkeypatch):
    from fastapi import FastAPI
    from app.api.routes import incidents as routes
    from app.api.deps import get_current_user

    monkeypatch.setattr(routes, "async_session_factory", env.db)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api")
    actor = SimpleNamespace(username="synthetic", role="viewer")
    app.dependency_overrides[get_current_user] = lambda: actor
    await env.ingest()
    item = (await env.rows(Incident))[0]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/api/incidents")).status_code == 200
        path = f"/api/incidents/{item.id}/status"
        payload = {"revision": 0, "status": "approved", "note": "Taking ownership"}
        assert (await client.post(path, json=payload)).status_code == 403
        assert (await client.get("/api/settings/incidents")).status_code == 403
        actor.role = "operator"
        assert (await client.post(path, json=payload)).status_code == 200
        assert (await client.post(path, json=payload)).status_code == 409
        assert (
            await client.post(
                path, json={"revision": 1, "status": "completed", "note": "Fixed"}
            )
        ).status_code == 200
        assert (
            await client.post(path, json={"revision": 2, "status": "in_progress"})
        ).status_code == 409
        result = (await client.get(f"/api/incidents/{item.id}")).json()
        assert [r["status"] for r in result["history"]] == [
            "new",
            "approved",
            "completed",
        ]
        assert "room_digest" not in str(result)
        actor.role = "admin"
        cfg = (await client.get("/api/settings/incidents")).json()
        cfg.pop("transport_enabled")
        cfg.pop("memory_enabled")
        assert (
            await client.put(
                "/api/settings/incidents", json={**cfg, "talk_enabled": False}
            )
        ).status_code == 200
        assert (
            await client.put("/api/settings/incidents", json=cfg)
        ).status_code == 409


@requires_db
@pytest.mark.asyncio
async def test_real_collector_groups_resources_and_does_not_clear_on_fetch_failure(
    env, monkeypatch
):
    from app.schemas.traffic_settings import TrafficSettingsConfig

    monkeypatch.setattr(
        watch, "traffic_config", AsyncMock(return_value=TrafficSettingsConfig())
    )
    t = im.utcnow()
    monkeypatch.setattr(im, "utcnow", lambda: t)
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: [alert(), alert("DiskCritical", "critical")],
    )
    http = AsyncMock()
    http.__aenter__.return_value.get.return_value = response
    monkeypatch.setattr(watch.httpx, "AsyncClient", lambda **kw: http)
    await watch.collect_once()
    assert len(await env.rows(Incident)) == 1
    t += timedelta(seconds=15)
    await watch.collect_once()
    assert len(await env.rows(Incident)) == 1
    http.__aenter__.return_value.get.side_effect = httpx.ConnectError(
        "synthetic outage"
    )
    t += timedelta(seconds=15)
    await watch.collect_once()
    rows = await env.rows(Incident)
    assert len(rows) == 2
    assert rows[0].source_state == "unknown"
    assert rows[1].rule == "alert_source_unavailable"
    t += timedelta(seconds=15)
    await watch.collect_once()
    assert len(await env.rows(Incident)) == 2


@requires_db
@pytest.mark.asyncio
async def test_silenced_alert_never_proves_recovery_or_sends(env):
    t = im.utcnow()
    a = alert()
    a["status"]["state"] = "suppressed"
    await env.ingest(im.resource_candidates([a]), now=t)
    assert not await env.rows(IMDelivery)
    await env.complete()
    for minute in range(1, 35):
        await env.ingest(im.resource_candidates([a]), now=t + timedelta(minutes=minute))
    await env.ingest(now=t + timedelta(minutes=35))
    assert len(await env.rows(Incident)) == 1


@pytest.mark.asyncio
async def test_explicit_ip_changes_bypass_dns_cache(monkeypatch):
    from app.services import traffic_auth
    from app.schemas.traffic_settings import TrafficSettingsConfig

    monkeypatch.setattr(traffic_auth, "_cache", None)
    first = await traffic_auth.trusted_origins(
        TrafficSettingsConfig(trusted_ips=["203.0.113.10"])
    )
    second = await traffic_auth.trusted_origins(
        TrafficSettingsConfig(trusted_ips=["203.0.113.11"])
    )
    assert first["trusted_ips"] == ["203.0.113.10"]
    assert second["trusted_ips"] == ["203.0.113.11"]
