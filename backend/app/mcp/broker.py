"""Common admission and execution boundary for external and Ops Floor MCP clients."""

import asyncio
import json
import re
import uuid
from datetime import timedelta
from urllib.parse import quote
import httpx
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from app.db.session import async_session_factory
from app.models.mcp import MCPRequest, MCPAudit
from app.models.user import User
from app.mcp.catalog import TOOLS, permitted, validate
from app.mcp.common import (
    now,
    grant_context,
    canonical,
    digest,
    encrypt,
    decrypt,
    audit,
    sanitize,
)
from app.services.auth import role_at_least

# This object lives only inside the process; a client header cannot manufacture it.
INTERNAL_PRINCIPAL = object()
MAX_ARGUMENT_BYTES = 65536
MAX_RESULT_BYTES = 262144


async def context(db, token, tool=None):
    grant, client, user = await grant_context(db, uuid.UUID(token.claims["grant_id"]))
    if tool and not permitted(tool, grant, client, user, token.scopes):
        raise HTTPException(403, "Tool is not permitted")
    if grant.agent_id:
        from app.models.ai import AIAgent, AITask

        agent = await db.get(AIAgent, grant.agent_id)
        task_id = token.claims.get("task_id")
        task = await db.get(AITask, uuid.UUID(task_id)) if task_id else None
        if (
            not agent
            or not agent.enabled
            or not task
            or task.owner_user_id != user.id
            or task.status != "running"
            or task.source not in ("web", "talk")
        ):
            raise HTTPException(403, "Agent task authorization is unavailable")
        if tool and tool["name"] not in (agent.allowed_tools or []):
            raise HTTPException(403, "Tool is not permitted for this agent")
    return grant, client, user


async def agent_target_check(db, grant, tool, args):
    if not grant.agent_id:
        return
    from app.models.ai import AIAgent
    from app.models.host import Host

    agent = await db.get(AIAgent, grant.agent_id)
    if not agent.allowed_hosts and not agent.allowed_environments:
        return
    # Only explicitly host-bound operations can run for a restricted agent.
    # Global lists/configuration/jobs may contain other hosts and fail closed.
    path = tool["path"]
    params = args.get("path", {})
    host = None
    if path.startswith(
        (
            "/api/hosts/{host_id}",
            "/api/containers/{hostname}",
            "/api/docker-hosts/{hostname}",
        )
    ):
        if "host_id" in params:
            host = await db.get(Host, uuid.UUID(params["host_id"]))
        elif "hostname" in params:
            host = (
                await db.execute(
                    select(Host).where(Host.hostname == params["hostname"])
                )
            ).scalar_one_or_none()
    if (
        not host
        or (agent.allowed_hosts and host.hostname not in agent.allowed_hosts)
        or (
            agent.allowed_environments
            and host.environment not in agent.allowed_environments
        )
    ):
        raise HTTPException(403, "This tool target is outside the agent host policy")


async def invoke(app, tool, arguments, user_id):
    path = tool["path"]
    for key, value in arguments.get("path", {}).items():
        value = str(value)
        if not value or value in (".", "..") or re.search(r"[/\\%?#\x00-\x1f]", value):
            raise HTTPException(400, "Invalid path parameter")
        path = path.replace("{" + key + "}", quote(value, safe=""))
    if "{" in path:
        raise HTTPException(400, "Missing path parameter")

    async def local(scope, receive, send):
        scope["ops_mcp_principal"] = (INTERNAL_PRINCIPAL, str(user_id))
        await app(scope, receive, send)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=local), base_url="http://ops-internal"
    ) as client:
        async with asyncio.timeout(45):
            response = await client.request(
                tool["method"],
                path,
                params=arguments.get("query"),
                json=arguments.get("body") if "body" in arguments else None,
            )
    if len(response.content) > MAX_RESULT_BYTES:
        return {
            "status_code": response.status_code,
            "truncated": True,
            "message": "Result exceeds the MCP limit. Narrow the query or view it in Ops Center.",
        }
    try:
        data = sanitize(response.json()) if response.content else None
    except ValueError:
        data = {"message": "Non-JSON result is available in Ops Center."}
    return {"status_code": response.status_code, "data": data}


async def call(app, token, name, arguments):
    tool = TOOLS.get(name)
    if not tool:
        raise HTTPException(404, "Unknown tool")
    validate(tool, arguments)
    if len(canonical(arguments).encode()) > MAX_ARGUMENT_BYTES:
        raise HTTPException(413, "Tool arguments are too large")
    async with async_session_factory() as db:
        grant, client, user = await context(db, token, tool)
        await agent_target_check(db, grant, tool, arguments)
        # Serialize admission per user across clients and API replicas.
        await db.execute(select(User.id).where(User.id == user.id).with_for_update())
        count = await db.scalar(
            select(func.count())
            .select_from(MCPAudit)
            .where(
                MCPAudit.user_id == str(user.id),
                MCPAudit.created_at > now() - timedelta(minutes=1),
                MCPAudit.outcome.in_(["admitted", "pending"]),
            )
        )
        if count >= 60:
            raise HTTPException(429, "MCP tool rate exceeded")
        if tool["method"] != "GET":
            existing = (
                await db.execute(
                    select(MCPRequest).where(
                        MCPRequest.grant_id == grant.id,
                        MCPRequest.idempotency_key == arguments["idempotency_key"],
                    )
                )
            ).scalar_one_or_none()
            if existing:
                if existing.tool != name or existing.argument_digest != digest(
                    canonical(arguments)
                ):
                    raise HTTPException(
                        409, "Idempotency key belongs to different arguments"
                    )
                return request_result(existing)
            pending = await db.scalar(
                select(func.count())
                .select_from(MCPRequest)
                .where(
                    MCPRequest.grant_id == grant.id,
                    MCPRequest.status == "pending",
                    MCPRequest.expires_at > now(),
                )
            )
            if pending >= 20:
                raise HTTPException(429, "Too many pending change requests")
            row = MCPRequest(
                grant_id=grant.id,
                tool=name,
                idempotency_key=arguments["idempotency_key"],
                argument_digest=digest(canonical(arguments)),
                encrypted_arguments=encrypt(arguments),
                expires_at=min(now() + timedelta(minutes=15), grant.expires_at),
                token_scopes=list(token.scopes),
                task_id=token.claims.get("task_id"),
            )
            db.add(row)
            try:
                await db.flush()
                await audit(
                    db,
                    name,
                    "pending",
                    grant=grant,
                    user=user,
                    args=arguments,
                    request_id=row.id,
                    task_id=row.task_id,
                )
                await db.commit()
            except IntegrityError:
                await db.rollback()
                # A racing duplicate returns through the same comparison checks.
                return await call(app, token, name, arguments)
            return request_result(row)
        await audit(
            db,
            name,
            "admitted",
            grant=grant,
            user=user,
            args=arguments,
            task_id=token.claims.get("task_id"),
        )
        await db.commit()  # Fail closed if audit storage is unavailable.
        user_id = user.id
    try:
        result = await invoke(app, tool, arguments, user_id)
    except Exception:
        result = {"status_code": 502, "message": "Operational data is unavailable."}
    async with async_session_factory() as db:
        await audit(
            db,
            name,
            "read_completed" if result["status_code"] < 400 else "read_failed",
            grant=grant,
            user=user,
            args=arguments,
            task_id=token.claims.get("task_id"),
        )
        await db.commit()
    return result


def request_result(row):
    return {
        "request_id": str(row.id),
        "status": row.status,
        "expires_at": row.expires_at.isoformat(),
        "message": (
            "Review and decide in Ops Center."
            if row.status == "pending"
            else "Stored request status."
        ),
        "result": row.result,
    }


async def decide(app, request_id, human, approve, expected_digest):
    from types import SimpleNamespace

    async with async_session_factory() as db:
        row = (
            await db.execute(
                select(MCPRequest).where(MCPRequest.id == request_id).with_for_update()
            )
        ).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "Request not found")
        grant, client, user = await grant_context(db, row.grant_id)
        tool = TOOLS[row.tool]
        if human.id != user.id and human.role != "admin":
            raise HTTPException(
                403, "Only the authorizing user or an administrator may decide"
            )
        if not role_at_least(human.role, tool["minimum_role"]):
            raise HTTPException(403, "Insufficient approval role")
        if (
            row.status != "pending"
            or row.expires_at <= now()
            or row.argument_digest != expected_digest
        ):
            raise HTTPException(409, "Request changed, expired or was already decided")
        if not approve:
            row.status = "rejected"
            row.decided_by = human.id
            row.encrypted_arguments = None
            await audit(
                db,
                row.tool,
                "rejected",
                grant=grant,
                user=human,
                request_id=row.id,
                task_id=row.task_id,
            )
            await db.commit()
            return request_result(row)
        args = decrypt(row.encrypted_arguments)
        if digest(canonical(args)) != row.argument_digest:
            raise HTTPException(409, "Approval payload integrity check failed")
        token = SimpleNamespace(
            claims={
                "grant_id": str(grant.id),
                "task_id": str(row.task_id) if row.task_id else None,
            },
            scopes=row.token_scopes,
        )
        # An internal agent commonly completes its answer while awaiting approval.
        # Its task must still exist and not be cancelled; recheck below separately.
        if grant.agent_id:
            from app.models.ai import AIAgent, AITask

            agent = await db.get(AIAgent, grant.agent_id)
            task = await db.get(AITask, row.task_id) if row.task_id else None
            if (
                not agent
                or not agent.enabled
                or row.tool not in agent.allowed_tools
                or not task
                or task.status in ("cancelled", "failed")
                or task.source not in ("web", "talk")
                or task.owner_user_id != user.id
            ):
                raise HTTPException(403, "Agent authorization was revoked")
        if not permitted(tool, grant, client, user, token.scopes):
            raise HTTPException(403, "Tool authorization was revoked")
        validate(tool, args)
        await agent_target_check(db, grant, tool, args)
        row.status = "executing"
        row.decided_by = human.id
        await audit(
            db,
            row.tool,
            "executing",
            grant=grant,
            user=human,
            args=args,
            request_id=row.id,
            task_id=row.task_id,
        )
        await db.commit()  # One claim, committed before the business operation.
        user_id = user.id
    try:
        result = await invoke(app, tool, args, user_id)
        status = (
            "completed"
            if result["status_code"] < 400
            else "unknown" if result["status_code"] >= 500 else "failed"
        )
    except Exception:
        result = {
            "message": "Execution outcome is unknown. Inspect Ops Center before creating another request."
        }
        status = "unknown"
    async with async_session_factory() as db:
        row = await db.get(MCPRequest, request_id)
        row.status = status
        row.result = result
        row.encrypted_arguments = None
        await audit(
            db,
            row.tool,
            status,
            grant=grant,
            user=human,
            request_id=row.id,
            task_id=row.task_id,
        )
        await db.commit()
        return request_result(row)
