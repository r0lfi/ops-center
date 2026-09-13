"""Shared security primitives; no browser/API tokens are accepted by MCP."""

import base64
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import urlsplit, parse_qs
from cryptography.fernet import Fernet
from fastapi import HTTPException
from sqlalchemy import select
from app.core.config import get_settings
from app.models.mcp import MCPSettings, MCPClient, MCPGrant, MCPAudit
from app.models.user import User


def now():
    return datetime.now(timezone.utc)


def opaque():
    return secrets.token_urlsafe(32)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def canonical(value):
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def cipher():
    key = hmac.new(
        get_settings().api_secret_key.encode(),
        b"ops-center-mcp-requests-v1",
        hashlib.sha256,
    ).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value):
    return cipher().encrypt(canonical(value).encode()).decode()


def decrypt(value):
    return json.loads(cipher().decrypt(value.encode()))


def public_url():
    value = get_settings().mcp_public_url.rstrip("/")
    parts = urlsplit(value)
    if (
        not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or parts.path != "/mcp"
    ):
        raise ValueError("MCP_PUBLIC_URL must be an absolute URL ending in /mcp")
    if parts.scheme != "https" and not (
        parts.scheme == "http" and parts.hostname in ("127.0.0.1", "::1", "localhost")
    ):
        raise ValueError("MCP requires HTTPS except on loopback")
    return value


def origin():
    return public_url().removesuffix("/mcp")


def validate_redirect(value):
    p = urlsplit(value)
    if not p.hostname or p.username or p.password or p.fragment or len(value) > 1000:
        raise ValueError("Invalid redirect URI")
    if p.scheme != "https" and not (
        p.scheme == "http" and p.hostname in ("127.0.0.1", "::1", "localhost")
    ):
        raise ValueError("Redirects require HTTPS or loopback HTTP")
    if any(c in value for c in ("\r", "\n", "\\", "*")):
        raise ValueError("Redirect URI must be exact")
    if set(parse_qs(p.query)) & {"code", "state", "error", "error_description"}:
        raise ValueError(
            "Redirect URI cannot contain reserved OAuth response parameters"
        )
    from pydantic import AnyUrl

    if str(AnyUrl(value)) != value:
        raise ValueError("Use the normalized exact redirect URI, including its path")
    return value


async def active(db):
    state = await db.get(MCPSettings, 1)
    if not state or not state.enabled:
        raise HTTPException(503, "MCP is disabled")
    public_url()


async def grant_context(db, grant_id):
    await active(db)
    grant = await db.get(MCPGrant, grant_id)
    if (
        not grant
        or grant.revoked_at
        or grant.expires_at <= now()
        or grant.resource != public_url()
    ):
        raise HTTPException(403, "MCP authorization is unavailable")
    client = await db.get(MCPClient, grant.client_id)
    user = await db.get(User, grant.user_id)
    if not client or not client.enabled or not user or not user.is_active:
        raise HTTPException(403, "MCP authorization is unavailable")
    if str(user.id) not in client.allowed_user_ids:
        raise HTTPException(403, "User is not permitted for this MCP client")
    return grant, client, user


async def audit(
    db,
    operation,
    outcome,
    *,
    grant=None,
    user=None,
    args=None,
    request_id=None,
    task_id=None
):
    db.add(
        MCPAudit(
            operation=operation,
            outcome=outcome,
            user_id=str(user.id) if user else None,
            client_id=grant.client_id if grant else None,
            grant_id=str(grant.id) if grant else None,
            agent_id=str(grant.agent_id) if grant and grant.agent_id else None,
            task_id=str(task_id) if task_id else None,
            argument_digest=digest(canonical(args)) if args is not None else None,
            request_id=str(request_id) if request_id else None,
        )
    )


def sanitize(value):
    if isinstance(value, dict):
        return {
            k: (
                "[redacted]"
                if re.search(
                    r"password|secret|token|cookie|authorization|private.?key", k, re.I
                )
                else (
                    ["[redacted environment value]" for _ in v]
                    if k == "Env" and isinstance(v, list)
                    else sanitize(v)
                )
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value
