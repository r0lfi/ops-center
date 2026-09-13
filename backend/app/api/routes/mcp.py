"""Human-only MCP administration, consent and decisions (browser JWT authentication)."""

import uuid
from datetime import timedelta
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.mcp import (
    MCPSettings,
    MCPClient,
    MCPGrant,
    MCPAuthorization,
    MCPRequest,
    MCPAudit,
)
from app.models.user import User
from app.mcp.common import (
    active,
    audit,
    canonical,
    decrypt,
    digest,
    now,
    opaque,
    origin,
    public_url,
    validate_redirect,
)
from app.mcp.catalog import TOOLS, SCOPES, permitted
from app.mcp import broker
from app.services.auth import role_at_least

router = APIRouter(prefix="/mcp")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SettingsWrite(Strict):
    enabled: bool
    revision: int


class ClientWrite(Strict):
    name: str = Field(min_length=1, max_length=100)
    redirect_uris: list[str] = Field(min_length=1, max_length=20)
    scopes: list[str] = Field(min_length=1, max_length=100)
    allowed_tools: list[str] = Field(min_length=1, max_length=200)
    allowed_user_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)
    enabled: bool = True


class ConsentWrite(Strict):
    approve: bool
    allowed_tools: list[str] = Field(default_factory=list, max_length=200)
    days: int = Field(default=1, ge=1, le=30)


class Decision(Strict):
    approve: bool
    argument_digest: str = Field(pattern="^[a-f0-9]{64}$")


class AgentGrantWrite(Strict):
    agent_id: uuid.UUID
    user_id: uuid.UUID
    allowed_tools: list[str] = Field(min_length=1, max_length=200)
    days: int = Field(default=1, ge=1, le=30)


def client_view(c):
    return {
        k: getattr(c, k)
        for k in (
            "id",
            "name",
            "redirect_uris",
            "scopes",
            "allowed_tools",
            "allowed_user_ids",
            "enabled",
        )
    }


def grant_view(g):
    return {
        k: getattr(g, k)
        for k in (
            "id",
            "client_id",
            "user_id",
            "agent_id",
            "scopes",
            "allowed_tools",
            "expires_at",
            "revoked_at",
        )
    }


async def verify_tools_users(db, names, user_ids):
    if not names or set(names) - TOOLS.keys():
        raise HTTPException(400, "Choose known tools")
    for ident in user_ids:
        user = await db.get(User, ident)
        if not user or not user.is_active:
            raise HTTPException(400, "Choose active users")


@router.get("/settings")
async def settings(
    db: AsyncSession = Depends(get_db), user: User = Depends(require_role("admin"))
):
    state = await db.get(MCPSettings, 1)
    try:
        url = public_url()
    except ValueError:
        url = None
    return {
        "enabled": bool(state and state.enabled),
        "revision": state.revision if state else 1,
        "public_url": url,
        "scopes": SCOPES,
        "tools": list(TOOLS.values()),
    }


@router.put("/settings")
async def update_settings(
    payload: SettingsWrite,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    state = (
        await db.execute(
            select(MCPSettings).where(MCPSettings.id == 1).with_for_update()
        )
    ).scalar_one()
    if state.revision != payload.revision:
        raise HTTPException(409, "Settings changed; reload before saving")
    if payload.enabled:
        try:
            public_url()
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    state.enabled = payload.enabled
    state.revision += 1
    await audit(db, "settings", "updated", user=user)
    await db.commit()
    return {"enabled": state.enabled, "revision": state.revision}


@router.get("/clients")
async def clients(
    db: AsyncSession = Depends(get_db), user: User = Depends(require_role("admin"))
):
    return [
        client_view(c)
        for c in (
            await db.execute(
                select(MCPClient).order_by(MCPClient.created_at.desc()).limit(500)
            )
        ).scalars()
        if not c.id.startswith("internal:")
    ]


async def write_client(db, user, payload, ident=None):
    await verify_tools_users(db, payload.allowed_tools, payload.allowed_user_ids)
    if set(payload.scopes) - set(SCOPES) or "ops:connect" not in payload.scopes:
        raise HTTPException(400, "Choose known scopes including ops:connect")
    if any(TOOLS[t]["scope"] not in payload.scopes for t in payload.allowed_tools):
        raise HTTPException(400, "Tool scopes must be included")
    try:
        redirects = [validate_redirect(v) for v in payload.redirect_uris]
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    row = await db.get(MCPClient, ident) if ident else MCPClient(id=opaque())
    if row is None or row.id.startswith("internal:"):
        raise HTTPException(404, "Client not found")
    for k, v in payload.model_dump().items():
        setattr(row, k, v)
    row.redirect_uris = redirects
    row.allowed_user_ids = [str(i) for i in payload.allowed_user_ids]
    db.add(row)
    await audit(db, "client", "updated", user=user)
    await db.commit()
    return client_view(row)


@router.post("/clients", status_code=201)
async def create_client(
    payload: ClientWrite,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    return await write_client(db, user, payload)


@router.put("/clients/{client_id}")
async def update_client(
    client_id: str,
    payload: ClientWrite,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    return await write_client(db, user, payload, client_id)


@router.get("/grants")
async def grants(
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    query = select(MCPGrant).order_by(MCPGrant.created_at.desc()).limit(500)
    if user.role != "admin":
        query = query.where(MCPGrant.user_id == user.id)
    return [grant_view(g) for g in (await db.execute(query)).scalars()]


@router.delete("/grants/{grant_id}")
async def revoke(
    grant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = await db.get(MCPGrant, grant_id)
    if not row or (row.user_id != user.id and user.role != "admin"):
        raise HTTPException(404, "Grant not found")
    row.revoked_at = now()
    await audit(db, "grant", "revoked", grant=row, user=user)
    await db.commit()
    return {"revoked": True}


@router.post("/agent-grants", status_code=201)
async def agent_grant(
    payload: AgentGrantWrite,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_role("admin")),
):
    from app.models.ai import AIAgent

    await active(db)
    await verify_tools_users(db, payload.allowed_tools, [payload.user_id])
    agent = await db.get(AIAgent, payload.agent_id)
    if not agent or not agent.enabled:
        raise HTTPException(400, "Choose an active agent")
    if set(payload.allowed_tools) - set(agent.allowed_tools or []):
        raise HTTPException(
            400, "Enable these tools on the agent before granting access"
        )
    scopes = sorted(
        {"ops:connect", *(TOOLS[n]["scope"] for n in payload.allowed_tools)}
    )
    client = MCPClient(
        id="internal:" + opaque(),
        name="Ops Floor: " + agent.name[:80],
        redirect_uris=[],
        scopes=scopes,
        allowed_tools=payload.allowed_tools,
        allowed_user_ids=[str(payload.user_id)],
    )
    db.add(client)
    await db.flush()
    grant = MCPGrant(
        client_id=client.id,
        user_id=payload.user_id,
        agent_id=agent.id,
        scopes=scopes,
        allowed_tools=payload.allowed_tools,
        resource=public_url(),
        expires_at=now() + timedelta(days=payload.days),
    )
    db.add(grant)
    await db.flush()
    await audit(db, "agent_grant", "created", grant=grant, user=user)
    await db.commit()
    return grant_view(grant)


async def authorization(db, ident, user, lock=False):
    await active(db)
    query = select(MCPAuthorization).where(MCPAuthorization.id == ident)
    row = (
        await db.execute(query.with_for_update() if lock else query)
    ).scalar_one_or_none()
    if not row or row.expires_at <= now() or row.consumed_at or row.code_hash:
        raise HTTPException(404, "Authorization request expired or already used")
    client = await db.get(MCPClient, row.client_id)
    if not client or not client.enabled or str(user.id) not in client.allowed_user_ids:
        raise HTTPException(403, "This user is not permitted for this client")
    if (
        row.parameters["resource"] != public_url()
        or row.parameters["redirect_uri"] not in client.redirect_uris
    ):
        raise HTTPException(403, "Client configuration changed")
    tools = [
        TOOLS[n]
        for n in client.allowed_tools
        if n in TOOLS
        and TOOLS[n]["scope"] in row.parameters["scopes"]
        and role_at_least(user.role, TOOLS[n]["minimum_role"])
    ]
    return row, client, tools


@router.get("/consent/{request_id}")
async def consent_details(
    request_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row, client, tools = await authorization(db, request_id, user)
    return {
        "client_name": client.name,
        "client_id": client.id,
        "redirect_uri": row.parameters["redirect_uri"],
        "resource": public_url(),
        "tools": tools,
        "expires_at": row.expires_at,
    }


@router.post("/consent/{request_id}")
async def consent(
    request_id: str,
    payload: ConsentWrite,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row, client, tools = await authorization(db, request_id, user, True)
    target = urlsplit(row.parameters["redirect_uri"])
    params = dict(parse_qsl(target.query))
    if payload.approve:
        if not payload.allowed_tools or set(payload.allowed_tools) - {
            t["name"] for t in tools
        }:
            raise HTTPException(400, "Choose a subset of the requested tools")
        scopes = sorted(
            {"ops:connect", *(TOOLS[n]["scope"] for n in payload.allowed_tools)}
        )
        grant = MCPGrant(
            client_id=client.id,
            user_id=user.id,
            scopes=scopes,
            allowed_tools=payload.allowed_tools,
            resource=public_url(),
            expires_at=now() + timedelta(days=payload.days),
        )
        db.add(grant)
        await db.flush()
        code = opaque()
        row.code_hash = digest(code)
        row.grant_id = grant.id
        row.expires_at = now() + timedelta(seconds=60)
        params["code"] = code
        await audit(db, "consent", "approved", grant=grant, user=user)
    else:
        row.consumed_at = now()
        params["error"] = "access_denied"
        await audit(db, "consent", "denied", user=user)
    if row.parameters.get("state") is not None:
        params["state"] = row.parameters["state"]
    await db.commit()
    return {
        "redirect_url": urlunsplit(
            (target.scheme, target.netloc, target.path, urlencode(params), "")
        )
    }


@router.get("/requests")
async def requests(
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    query = (
        select(MCPRequest)
        .join(MCPGrant)
        .order_by(MCPRequest.created_at.desc())
        .limit(100)
    )
    if user.role != "admin":
        query = query.where(MCPGrant.user_id == user.id)
    rows = (await db.execute(query)).scalars()
    return [
        {
            **broker.request_result(r),
            "tool": r.tool,
            "grant_id": r.grant_id,
            "argument_digest": r.argument_digest,
            "arguments": (
                decrypt(r.encrypted_arguments)
                if r.encrypted_arguments
                and r.status == "pending"
                and r.expires_at > now()
                else None
            ),
        }
        for r in rows
    ]


@router.post("/requests/{request_id}/decision")
async def decision(
    request_id: uuid.UUID,
    payload: Decision,
    request: Request,
    user: User = Depends(get_current_user),
):
    return await broker.decide(
        request.app, request_id, user, payload.approve, payload.argument_digest
    )


@router.get("/audit")
async def audit_log(
    db: AsyncSession = Depends(get_db), user: User = Depends(require_role("admin"))
):
    rows = (
        await db.execute(
            select(MCPAudit).order_by(MCPAudit.created_at.desc()).limit(200)
        )
    ).scalars()
    return [
        {
            k: getattr(r, k)
            for k in (
                "id",
                "created_at",
                "user_id",
                "client_id",
                "grant_id",
                "agent_id",
                "task_id",
                "operation",
                "outcome",
                "argument_digest",
                "request_id",
            )
        }
        for r in rows
    ]
