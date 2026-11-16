"""Ops Floor uses the same standard MCP transport and broker as external clients."""

import asyncio
import hashlib
import ipaddress
import socket
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from sqlalchemy import select
from app.core.config import get_settings
from app.models.mcp import MCPGrant, MCPToken, MCPClient, MCPSettings
from app.models.ai import AITask, AIAgent
from app.models.user import User
from app.core.incident_tasks import incident_task_authorized

from app.core import config as shared_config

CATALOG = json.loads(
    Path(shared_config.__file__).with_name("mcp_catalog.json").read_text()
)
MCP_SCHEMAS = {
    t["name"]: {
        "name": t["name"],
        "description": t["description"],
        "parameters": t["input_schema"],
    }
    for t in CATALOG["tools"]
}


def lan_only(url):
    """Agents may use MCP only inside the local network, never toward the internet.

    True when the endpoint's host resolves exclusively to private, loopback
    or link-local addresses. The URL is the administrator's MCP_PUBLIC_URL;
    this makes "no outbound MCP" a code guarantee rather than configuration.
    """
    host = urlsplit(url or "").hostname
    if not host:
        return False
    try:
        addresses = {ipaddress.ip_address(info[4][0].split("%")[0]) for info in socket.getaddrinfo(host, None)}
    except (OSError, ValueError):
        return False
    return bool(addresses) and all((a.is_private or a.is_loopback or a.is_link_local) and not a.is_global for a in addresses)


def granted_tools(db, agent_id, user_id, names):
    """The subset of names this agent may call for this user right now.

    Only these are offered to the model, so an expired or missing grant shows
    up as an access problem in Ops Center instead of a tool error mid-run.
    call_tool still re-checks everything at call time.
    """
    names = [n for n in names if n in MCP_SCHEMAS]
    if not names or not user_id:
        return []
    state = db.get(MCPSettings, 1)
    if not state or not state.enabled:
        return []
    allowed = set()
    for grant in db.execute(select(MCPGrant).where(
            MCPGrant.agent_id == agent_id, MCPGrant.user_id == user_id,
            MCPGrant.revoked_at.is_(None),
            MCPGrant.expires_at > datetime.now(timezone.utc))).scalars():
        allowed.update(grant.allowed_tools or [])
    return [n for n in names if n in allowed]


def access_required(db, agent, user_id, name, stamp):
    """A structured access problem: never something a prompt can fix."""
    expired = db.execute(select(MCPGrant.expires_at).where(
        MCPGrant.agent_id == agent.id, MCPGrant.user_id == user_id,
        MCPGrant.revoked_at.is_(None), MCPGrant.expires_at <= stamp)
        .order_by(MCPGrant.expires_at.desc()).limit(1)).scalar()
    label = getattr(agent, "name", None) or "This agent"
    expired = expired if isinstance(expired, datetime) else None
    why = (f"the MCP grant for {label} expired on {expired:%Y-%m-%d}" if expired
           else f"{label} has no MCP grant for this user")
    return {"error": f"Access required: {why}. An administrator must grant or renew it in Settings > MCP.",
            "access_required": {"tool": name, "agent": getattr(agent, "slug", None), "reason": "expired" if expired else "missing"},
            "hint": "Use this agent's native read tools instead; do not retry this tool in this run."}


def call_tool(db, agent, task_id, name, arguments):
    from app.models.mcp import MCPAudit

    stamp = datetime.now(timezone.utc)
    db.expire_all()
    current = db.get(AIAgent, agent.id)
    task = db.get(AITask, task_id) if task_id else None
    state = db.get(MCPSettings, 1)
    if (
        not state
        or not state.enabled
        or not current
        or not current.enabled
        or name not in current.allowed_tools
        or not task
        or not task.owner_user_id
        or task.status != "running"
        or task.source not in ("web", "talk", "incident")
        or (task.source == "incident" and not incident_task_authorized(db, task))
    ):
        return {"error": "MCP tool access is unavailable for this agent task"}
    user = db.get(User, task.owner_user_id)
    if not user or not user.is_active:
        return {"error": "Task owner is unavailable"}
    grants = db.execute(
        select(MCPGrant)
        .where(
            MCPGrant.agent_id == current.id,
            MCPGrant.user_id == user.id,
            MCPGrant.revoked_at.is_(None),
            MCPGrant.expires_at > stamp,
        )
        .order_by(MCPGrant.created_at.desc())
    ).scalars()
    grant = next((g for g in grants if name in g.allowed_tools), None)
    resource = get_settings().mcp_public_url.rstrip("/")
    if grant and grant.resource != resource:
        return {
            "error": "The configured MCP resource changed; request a new authorization"
        }
    if not grant:
        from worker_ai.ai import netlog
        netlog.access("No live MCP grant for this tool and task owner; an access request was raised", tool=name,
                      host=urlsplit(resource).hostname if resource else None, rule="mcp.grant")
        return access_required(db, current, user.id, name, stamp)
    client = db.get(MCPClient, grant.client_id)
    if (
        not client
        or not client.enabled
        or name not in client.allowed_tools
        or str(user.id) not in client.allowed_user_ids
    ):
        return {"error": "MCP client authorization was revoked"}
    # Checked before a credential is issued: no token is ever minted for a non-LAN endpoint.
    if not lan_only(resource):
        from worker_ai.ai import netlog
        netlog.access("MCP endpoint is not a LAN address; no request was sent", tool=name,
                      host=urlsplit(resource).hostname if resource else None, rule="mcp.lan_only")
        return {"error": "MCP is limited to the local network and the configured endpoint is not a LAN address; no request was sent"}
    raw = secrets.token_urlsafe(32)
    token = MCPToken(
        digest=hashlib.sha256(raw.encode()).hexdigest(),
        grant_id=grant.id,
        kind="access",
        scopes=sorted(set(grant.scopes) & set(client.scopes)),
        task_id=task.id,
        expires_at=min(stamp + timedelta(seconds=90), grant.expires_at),
    )
    db.add(token)
    db.add(
        MCPAudit(
            operation="agent.token",
            outcome="issued",
            user_id=str(user.id),
            client_id=grant.client_id,
            grant_id=str(grant.id),
            agent_id=str(current.id),
            task_id=str(task.id),
        )
    )
    db.commit()

    async def run():
        import httpx2
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client

        # Validate TLS using the normal system CA trust; no redirects or
        # provider-selected URL. Only the administrator's MCP_PUBLIC_URL.
        async with httpx2.AsyncClient(
            headers={"Authorization": "Bearer " + raw},
            timeout=45,
            follow_redirects=False,
        ) as http:
            async with streamable_http_client(resource, http_client=http) as streams:
                async with ClientSession(
                    streams[0], streams[1], read_timeout_seconds=45
                ) as session:
                    await session.initialize()
                    result = await session.call_tool(name, arguments)
                    if result.structured_content is not None:
                        return result.structured_content
                    return {
                        "error": result.is_error,
                        "content": [
                            c.text for c in result.content if hasattr(c, "text")
                        ],
                    }

    try:
        return asyncio.run(run())
    except Exception:
        return {
            "error": "MCP connection failed. Check request status in Ops Center before repeating any change."
        }
    finally:
        # This credential is only for one tool-call session.
        db.refresh(token)
        token.consumed_at = datetime.now(timezone.utc)
        db.commit()
