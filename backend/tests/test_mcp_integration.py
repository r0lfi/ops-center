"""Opt-in PostgreSQL tests. Never run against an application database."""

import asyncio
import base64
import hashlib
import json
import os
import uuid
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import urlsplit, parse_qs
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        os.environ.get("OPS_MCP_TEST_DATABASE") != "ops_mcp_test",
        reason="requires an isolated MCP test database",
    ),
]


@pytest_asyncio.fixture
async def env(monkeypatch):
    from app.core.config import get_settings
    from app.main import app
    from app.db import session as db_module
    from app.mcp import oauth, broker, server as server_module, maintenance
    from app.mcp.server import create_server
    from app.mcp.guard import MCPGuard
    from app.models.user import User
    from app.models.mcp import MCPSettings, MCPClient
    from app.services.auth import create_access_token

    url = get_settings().database_url
    assert urlsplit(url).path == "/ops_mcp_test", "Refusing non-test database"
    engine = create_async_engine(url, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    for module in (db_module, oauth, broker, server_module, maintenance):
        monkeypatch.setattr(module, "async_session_factory", factory)
    async with factory() as db:
        settings = await db.get(MCPSettings, 1)
        settings.enabled = True
        user = User(
            id=uuid.uuid4(),
            username="mcp-test-" + uuid.uuid4().hex,
            password_hash="unused",
            role="admin",
            is_active=True,
        )
        other = User(
            id=uuid.uuid4(),
            username="mcp-test-" + uuid.uuid4().hex,
            password_hash="unused",
            role="viewer",
            is_active=True,
        )
        db.add_all([user, other])
        await db.flush()
        client = MCPClient(
            id=uuid.uuid4().hex,
            name="Synthetic MCP client",
            redirect_uris=["http://127.0.0.1:43871/callback"],
            scopes=["ops:connect", "ops:hosts:read", "ops:ai_memory:write"],
            allowed_tools=["ops_list_hosts", "ops_save_memory"],
            allowed_user_ids=[str(user.id)],
            enabled=True,
        )
        # Catalog tag for memory is ai-memory, normalized to ai_memory.
        from app.mcp.catalog import TOOLS

        client.scopes = [
            "ops:connect",
            TOOLS["ops_list_hosts"]["scope"],
            TOOLS["ops_save_memory"]["scope"],
        ]
        db.add(client)
        await db.commit()
    server, mcp_app = create_server(app)

    async def dispatch(scope, receive, send):
        if scope.get("path") in (
            "/mcp",
            "/authorize",
            "/token",
            "/revoke",
        ) or scope.get("path", "").startswith("/.well-known/"):
            await mcp_app(scope, receive, send)
        else:
            await app(scope, receive, send)

    ready = asyncio.Event()
    stop = asyncio.Event()

    async def lifespan_task():
        async with server.session_manager.run():
            ready.set()
            await stop.wait()

    manager = asyncio.create_task(lifespan_task())
    await ready.wait()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=MCPGuard(dispatch)),
            base_url="https://ops.example.com",
        ) as http:
            yield SimpleNamespace(
                asgi=MCPGuard(dispatch),
                http=http,
                db=factory,
                user=user,
                other=other,
                client=client,
                app=app,
                jwt=create_access_token(str(user.id), user.username, user.role),
                other_jwt=create_access_token(
                    str(other.id), other.username, other.role
                ),
                provider=oauth.OpsOAuthProvider(),
            )
    finally:
        stop.set()
        await manager
    await engine.dispose()


def auth(jwt):
    return {"Authorization": "Bearer " + jwt}


async def begin(e, **changes):
    verifier = "synthetic-pkce-verifier-" + "a" * 43
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    params = {
        "client_id": e.client.id,
        "response_type": "code",
        "redirect_uri": e.client.redirect_uris[0],
        "scope": " ".join(e.client.scopes),
        "state": "synthetic-state",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": "https://ops.example.com/mcp",
    }
    params.update(changes)
    response = await e.http.get("/authorize", params=params)
    return response, verifier


async def authorize(e, tools=None):
    response, verifier = await begin(e)
    assert response.status_code in (302, 303), response.text
    ident = parse_qs(urlsplit(response.headers["location"]).query)["request"][0]
    detail = await e.http.get("/api/mcp/consent/" + ident, headers=auth(e.jwt))
    assert detail.status_code == 200, detail.text
    consent = await e.http.post(
        "/api/mcp/consent/" + ident,
        headers=auth(e.jwt),
        json={
            "approve": True,
            "allowed_tools": tools or ["ops_list_hosts", "ops_save_memory"],
            "days": 1,
        },
    )
    assert consent.status_code == 200, consent.text
    code = parse_qs(urlsplit(consent.json()["redirect_url"]).query)["code"][0]
    form = {
        "grant_type": "authorization_code",
        "client_id": e.client.id,
        "redirect_uri": e.client.redirect_uris[0],
        "code": code,
        "code_verifier": verifier,
        "resource": "https://ops.example.com/mcp",
    }
    return form, ident


async def token(e, tools=None):
    form, _ = await authorize(e, tools)
    response = await e.http.post("/token", data=form)
    assert response.status_code == 200, response.text
    return response.json(), form


async def rpc(e, raw, method, params=None):
    return await e.http.post(
        "/mcp",
        headers={
            **auth(raw),
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            **({"params": params} if params is not None else {}),
        },
    )


async def test_oauth_pkce_scope_resource_and_token_separation(env):
    e = env
    form, ident = await authorize(e, ["ops_list_hosts"])
    wrong = await e.http.post(
        "/token", data={**form, "code_verifier": "incorrect-verifier-" + "b" * 43}
    )
    assert wrong.status_code == 400
    for resource in ("https://other.example.com/mcp", ""):
        r = await e.http.post("/token", data={**form, "resource": resource})
        assert r.status_code == 400
    r = await e.http.post("/token", data=form)
    assert r.status_code == 200, r.text
    raw = r.json()["access_token"]
    listed = await rpc(e, raw, "tools/list")
    assert listed.status_code == 200, listed.text
    names = {t["name"] for t in listed.json()["result"]["tools"]}
    assert names == {"ops_list_hosts", "ops_request_status"}
    denied = await rpc(
        e,
        raw,
        "tools/call",
        {
            "name": "ops_save_memory",
            "arguments": {"idempotency_key": "test-one", "body": {}},
        },
    )
    assert denied.json()["result"]["isError"]
    assert (await rpc(e, e.jwt, "tools/list")).status_code == 401
    assert (await e.http.get("/api/auth/me", headers=auth(raw))).status_code == 401
    assert (await e.http.post("/token", data=form)).status_code == 400
    again = await e.http.post(
        "/api/mcp/consent/" + ident,
        headers=auth(e.jwt),
        json={"approve": True, "allowed_tools": ["ops_list_hosts"]},
    )
    assert again.status_code == 404


async def test_refresh_rotation_replay_revokes_family(env):
    e = env
    data, _ = await token(e)
    form = {
        "grant_type": "refresh_token",
        "client_id": e.client.id,
        "refresh_token": data["refresh_token"],
        "resource": "https://ops.example.com/mcp",
    }
    fresh = await e.http.post("/token", data=form)
    assert fresh.status_code == 200, fresh.text
    replay = await e.http.post("/token", data=form)
    assert replay.status_code == 400, replay.text
    assert (await rpc(e, fresh.json()["access_token"], "tools/list")).status_code == 401


async def test_client_user_revocation_and_role_rechecked(env):
    from app.models.mcp import MCPClient
    from app.models.user import User

    e = env
    data, _ = await token(e)
    async with e.db() as db:
        u = await db.get(User, e.user.id)
        u.role = "viewer"
        await db.commit()
    names = {
        t["name"]
        for t in (await rpc(e, data["access_token"], "tools/list")).json()["result"][
            "tools"
        ]
    }
    assert "ops_save_memory" not in names
    async with e.db() as db:
        c = await db.get(MCPClient, e.client.id)
        c.allowed_user_ids = []
        await db.commit()
    assert (await rpc(e, data["access_token"], "tools/list")).status_code == 401


async def test_origin_host_body_and_redirect_validation(env):
    e = env
    r, _ = await begin(e, redirect_uri="https://attacker.example/callback")
    assert r.status_code == 400
    r, _ = await begin(e, code_challenge_method="plain")
    assert r.status_code == 400 or (
        r.status_code == 302 and "error=" in r.headers["location"]
    )
    r = await e.http.post(
        "/token",
        headers={"Origin": "https://attacker.example"},
        data={"resource": "https://ops.example.com/mcp"},
    )
    assert r.status_code == 403
    r = await e.http.post("/mcp", headers={"Host": "attacker.example"}, json={})
    assert r.status_code == 421
    r = await e.http.post("/mcp", content=b"a" * 131073)
    assert r.status_code == 413
    assert (
        await e.http.get("/.well-known/oauth-protected-resource/mcp")
    ).status_code == 200


async def test_consent_requires_allowed_authenticated_human(env):
    e = env
    r, _ = await begin(e)
    ident = parse_qs(urlsplit(r.headers["location"]).query)["request"][0]
    assert (await e.http.get("/api/mcp/consent/" + ident)).status_code == 401
    assert (
        await e.http.get("/api/mcp/consent/" + ident, headers=auth(e.other_jwt))
    ).status_code == 403
    r = await e.http.post(
        "/api/mcp/consent/" + ident,
        headers=auth(e.jwt),
        json={"approve": True, "allowed_tools": ["ops_delete_host"]},
    )
    assert r.status_code == 400
    r = await e.http.post(
        "/api/mcp/consent/" + ident, headers=auth(e.jwt), json={"approve": False}
    )
    assert r.status_code == 200 and "error=access_denied" in r.json()["redirect_url"]


async def test_approval_exactly_once_and_revocation(env, monkeypatch):
    from app.mcp import broker
    from app.models.mcp import MCPRequest, MCPGrant, MCPAudit
    from app.mcp.catalog import TOOLS

    e = env
    data, _ = await token(e)
    tok = await e.provider.load_access_token(data["access_token"])
    calls = []

    async def effect(app, tool, args, user_id):
        calls.append(args)
        await asyncio.sleep(0.05)
        return {"status_code": 200, "data": {"ok": True}}

    monkeypatch.setattr(broker, "invoke", effect)
    # Build a valid body from the existing memory schema.
    body = {
        "key": "synthetic-note",
        "content": "Synthetic operational note",
        "scope": "shared",
    }
    args = {"body": body, "idempotency_key": "synthetic-idempotency"}
    result = await broker.call(e.app, tok, "ops_save_memory", args)
    again = await broker.call(e.app, tok, "ops_save_memory", args)
    assert result["request_id"] == again["request_id"] and not calls
    async with e.db() as db:
        row = await db.get(MCPRequest, uuid.UUID(result["request_id"]))
        fingerprint = row.argument_digest
        assert "Synthetic operational note" not in row.encrypted_arguments
        entries = list(
            (
                await db.execute(
                    select(MCPAudit).where(MCPAudit.grant_id == tok.claims["grant_id"])
                )
            ).scalars()
        )
        assert all(not hasattr(a, "arguments") for a in entries)
    decisions = await asyncio.gather(
        *(
            broker.decide(
                e.app, uuid.UUID(result["request_id"]), e.user, True, fingerprint
            )
            for _ in range(2)
        ),
        return_exceptions=True
    )
    assert len(calls) == 1
    assert (
        sum(isinstance(d, dict) and d["status"] == "completed" for d in decisions) == 1
    )
    args["idempotency_key"] = "synthetic-second"
    pending = await broker.call(e.app, tok, "ops_save_memory", args)
    async with e.db() as db:
        grant = await db.get(MCPGrant, uuid.UUID(tok.claims["grant_id"]))
        grant.revoked_at = __import__("app.mcp.common", fromlist=["now"]).now()
        row = await db.get(MCPRequest, uuid.UUID(pending["request_id"]))
        fingerprint = row.argument_digest
        await db.commit()
    with pytest.raises(Exception):
        await broker.decide(
            e.app, uuid.UUID(pending["request_id"]), e.user, True, fingerprint
        )
    assert len(calls) == 1


async def test_internal_principal_cannot_be_supplied_by_header(env):
    e = env
    response = await e.http.get(
        "/api/hosts", headers={"ops_mcp_principal": str(e.user.id)}
    )
    assert response.status_code == 401
    data, _ = await token(e, ["ops_list_hosts"])
    response = await rpc(
        e,
        data["access_token"],
        "tools/call",
        {"name": "ops_list_hosts", "arguments": {}},
    )
    assert (
        response.json()["result"]["structuredContent"]["status_code"] == 200
    ), response.text


async def test_agent_task_owner_and_tool_policy(env):
    from app.models.ai import AIAgent, AITask
    from app.models.mcp import MCPGrant, MCPToken
    from app.mcp.common import now, digest, opaque
    from app.mcp import broker

    e = env
    async with e.db() as db:
        agent = (await db.execute(select(AIAgent).limit(1))).scalar_one()
        agent.allowed_tools = ["ops_list_hosts"]
        agent.enabled = True
        task = AITask(
            agent_id=agent.id,
            owner_user_id=e.user.id,
            source="web",
            input_message="Synthetic",
            status="running",
        )
        db.add(task)
        await db.flush()
        grant = MCPGrant(
            client_id=e.client.id,
            user_id=e.user.id,
            agent_id=agent.id,
            resource="https://ops.example.com/mcp",
            scopes=e.client.scopes,
            allowed_tools=e.client.allowed_tools,
            expires_at=now() + timedelta(days=1),
        )
        db.add(grant)
        await db.flush()
        raw = opaque()
        db.add(
            MCPToken(
                digest=digest(raw),
                grant_id=grant.id,
                kind="access",
                scopes=grant.scopes,
                task_id=task.id,
                expires_at=now() + timedelta(minutes=1),
            )
        )
        await db.commit()
        task_id = task.id
    tok = await e.provider.load_access_token(raw)
    async with e.db() as db:
        await broker.context(db, tok)
    async with e.db() as db:
        task = await db.get(AITask, task_id)
        task.owner_user_id = e.other.id
        await db.commit()
    async with e.db() as db:
        with pytest.raises(Exception):
            await broker.context(db, tok)


async def test_no_approval_or_credential_tools_in_catalog(env):
    from app.mcp.catalog import TOOLS

    for t in TOOLS.values():
        assert not t["path"].startswith(("/api/auth", "/api/mcp", "/api/credentials"))
        assert not t["path"].endswith(("/approve", "/reject", "/key", "/config"))


async def test_standard_sdk_client_end_to_end(env):
    import httpx2
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    e = env
    data, _ = await token(e, ["ops_list_hosts"])
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=e.asgi), headers=auth(data["access_token"])
    ) as http:
        async with streamable_http_client(
            "https://ops.example.com/mcp", http_client=http
        ) as streams:
            async with ClientSession(*streams, read_timeout_seconds=10) as session:
                initialized = await session.initialize()
                assert initialized.server_info.name == "Ops Center"
                listing = await session.list_tools()
                assert {t.name for t in listing.tools} == {
                    "ops_list_hosts",
                    "ops_request_status",
                }
                result = await session.call_tool("ops_list_hosts", {})
                assert (
                    not result.is_error
                    and result.structured_content["status_code"] == 200
                )
                resources = await session.list_resources()
                assert {str(r.uri) for r in resources.resources} == {
                    "ops://policy",
                    "ops://capabilities",
                }
                prompts = await session.list_prompts()
                assert {p.name for p in prompts.prompts} == {
                    "investigate_incident",
                    "plan_maintenance",
                }
                assert (await session.read_resource("ops://policy")).contents
                assert (await session.get_prompt("plan_maintenance")).messages


async def test_wrong_client_and_duplicate_oauth_parameters(env):
    e = env
    form, _ = await authorize(e)
    r = await e.http.post("/token", data={**form, "client_id": "another-client"})
    assert r.status_code == 401
    r = await e.http.post(
        "/token",
        content="resource=https%3A%2F%2Fops.example.com%2Fmcp&resource=https%3A%2F%2Fother.example%2Fmcp",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 400
    r = await e.http.post("/token", data=form)
    assert r.status_code == 200


async def test_tool_input_path_and_idempotency_binding(env, monkeypatch):
    from app.mcp import broker
    from fastapi import HTTPException

    e = env
    data, _ = await token(e)
    tok = await e.provider.load_access_token(data["access_token"])
    for value in ("../credentials", "..", "a%2Fb", "a/b", "a?admin=true"):
        with pytest.raises(HTTPException):
            await broker.invoke(
                e.app,
                {"path": "/api/hosts/{host_id}", "method": "GET"},
                {"path": {"host_id": value}},
                e.user.id,
            )
    with pytest.raises(HTTPException):
        await broker.call(e.app, tok, "ops_list_hosts", {"unexpected": "value"})
    args = {
        "body": {"key": "synthetic", "content": "Synthetic"},
        "idempotency_key": "binding-check",
    }
    await broker.call(e.app, tok, "ops_save_memory", args)
    with pytest.raises(HTTPException):
        await broker.call(
            e.app,
            tok,
            "ops_save_memory",
            {**args, "body": {"key": "synthetic", "content": "Different"}},
        )


async def test_expired_or_changed_approval_is_not_executed(env, monkeypatch):
    from app.mcp import broker
    from app.models.mcp import MCPRequest
    from app.mcp.common import now

    e = env
    data, _ = await token(e)
    tok = await e.provider.load_access_token(data["access_token"])
    pending = await broker.call(
        e.app,
        tok,
        "ops_save_memory",
        {
            "body": {"key": "synthetic", "content": "Synthetic"},
            "idempotency_key": "expiry-check",
        },
    )
    ident = uuid.UUID(pending["request_id"])
    calls = []

    async def invoke(*args):
        calls.append(args)

    monkeypatch.setattr(broker, "invoke", invoke)
    with pytest.raises(Exception):
        await broker.decide(e.app, ident, e.user, True, "0" * 64)
    async with e.db() as db:
        row = await db.get(MCPRequest, ident)
        row.expires_at = now() - timedelta(seconds=1)
        fingerprint = row.argument_digest
        await db.commit()
    with pytest.raises(Exception):
        await broker.decide(e.app, ident, e.user, True, fingerprint)
    assert not calls


async def test_disabled_service_and_expired_tokens(env):
    from app.models.mcp import MCPSettings, MCPToken
    from app.mcp.common import now, digest

    e = env
    data, _ = await token(e)
    async with e.db() as db:
        row = await db.get(MCPToken, digest(data["access_token"]))
        row.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    assert (await rpc(e, data["access_token"], "tools/list")).status_code == 401
    data, _ = await token(e)
    async with e.db() as db:
        settings = await db.get(MCPSettings, 1)
        settings.enabled = False
        await db.commit()
    assert (await rpc(e, data["access_token"], "tools/list")).status_code == 401


async def test_agent_host_policy_rejects_global_reads(env):
    from app.models.ai import AIAgent
    from app.models.mcp import MCPGrant
    from app.mcp.common import now
    from app.mcp.catalog import TOOLS
    from app.mcp import broker

    e = env
    async with e.db() as db:
        agent = (await db.execute(select(AIAgent).limit(1))).scalar_one()
        agent.allowed_hosts = ["synthetic-host"]
        agent.allowed_environments = []
        grant = MCPGrant(
            client_id=e.client.id,
            user_id=e.user.id,
            agent_id=agent.id,
            resource="https://ops.example.com/mcp",
            scopes=e.client.scopes,
            allowed_tools=e.client.allowed_tools,
            expires_at=now() + timedelta(days=1),
        )
        db.add(grant)
        await db.flush()
        with pytest.raises(Exception):
            await broker.agent_target_check(db, grant, TOOLS["ops_list_hosts"], {})
        # No global fleet read is silently broadened for a host-restricted agent.
        await db.rollback()


async def test_retention_erases_expired_payload_without_execution(env):
    from app.mcp import broker, maintenance
    from app.models.mcp import MCPRequest
    from app.mcp.common import now

    e = env
    data, _ = await token(e)
    tok = await e.provider.load_access_token(data["access_token"])
    result = await broker.call(
        e.app,
        tok,
        "ops_save_memory",
        {
            "body": {"key": "synthetic", "content": "Erase expired payload"},
            "idempotency_key": "retention-check",
        },
    )
    ident = uuid.UUID(result["request_id"])
    async with e.db() as db:
        row = await db.get(MCPRequest, ident)
        row.expires_at = now() - timedelta(seconds=1)
        await db.commit()
    await maintenance.prune()
    async with e.db() as db:
        row = await db.get(MCPRequest, ident)
        assert row.status == "expired" and row.encrypted_arguments is None


async def test_uncertain_execution_is_never_retried(env, monkeypatch):
    from app.mcp import broker
    from app.models.mcp import MCPRequest

    e = env
    data, _ = await token(e)
    tok = await e.provider.load_access_token(data["access_token"])
    args = {
        "body": {"key": "synthetic", "content": "Synthetic"},
        "idempotency_key": "uncertain-check",
    }
    result = await broker.call(e.app, tok, "ops_save_memory", args)
    ident = uuid.UUID(result["request_id"])
    async with e.db() as db:
        row = await db.get(MCPRequest, ident)
        fingerprint = row.argument_digest
    calls = []

    async def uncertain(*args):
        calls.append(args)
        raise TimeoutError("Synthetic uncertain outcome")

    monkeypatch.setattr(broker, "invoke", uncertain)
    result = await broker.decide(e.app, ident, e.user, True, fingerprint)
    assert result["status"] == "unknown"
    again = await broker.call(e.app, tok, "ops_save_memory", args)
    assert again["status"] == "unknown" and len(calls) == 1
