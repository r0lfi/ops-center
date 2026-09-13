"""Ops Floor uses the same standard MCP transport and broker as external clients."""

import asyncio
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from sqlalchemy import select
from app.core.config import get_settings
from app.models.mcp import MCPGrant, MCPToken, MCPClient, MCPSettings
from app.models.ai import AITask, AIAgent
from app.models.user import User

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
        or task.source not in ("web", "talk")
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
        return {
            "error": "A human must grant this agent and user access in MCP settings"
        }
    client = db.get(MCPClient, grant.client_id)
    if (
        not client
        or not client.enabled
        or name not in client.allowed_tools
        or str(user.id) not in client.allowed_user_ids
    ):
        return {"error": "MCP client authorization was revoked"}
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
