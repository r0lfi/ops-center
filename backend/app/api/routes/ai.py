import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.ai import AIAction, AIAgent, AIFinding, AIProvider, AITask, AIUsage
from app.models.user import User
from app.schemas.ai import (
    AIActionRead,
    AIAgentCreate,
    AIAgentRead,
    AIAgentUpdate,
    AIFindingRead,
    AIProviderCreate,
    AIProviderKeySet,
    AIProviderRead,
    AIProviderUpdate,
    AITaskRead,
    AskRequest,
)
from app.services.ai_secrets import delete_provider_key, write_provider_key
from app.services.auth import decode_access_token, role_at_least
from app.services.celery_client import get_celery_client
from app.services.redis_client import get_redis_client

router = APIRouter()

# Carved out of `router` deliberately: EventSource (the browser API that
# consumes an SSE stream) cannot send an Authorization header, so this one
# route authenticates via a `token` query param instead of the blanket
# `dependencies=_AUTH` every other route here gets - see main.py, and
# containers.py's ws_router for the same reasoning applied to a WebSocket.
stream_router = APIRouter()

AGENT_EVENTS_CHANNEL = "ai_agent_events"
_STREAM_IDLE_TIMEOUT_SECONDS = 300


# --------------------------------------------------------------------- #
# Providers - admin-only. The key itself never appears in a response.
# --------------------------------------------------------------------- #
@router.get("/ai/providers", response_model=list[AIProviderRead])
async def list_providers(db: AsyncSession = Depends(get_db)) -> list[dict]:
    result = await db.execute(select(AIProvider).order_by(AIProvider.slug))
    return [
        {**p.__dict__, "has_key": bool(p.secret_path)}
        for p in result.scalars().all()
    ]


@router.post(
    "/ai/providers",
    response_model=AIProviderRead,
    status_code=201,
    dependencies=[Depends(require_role("admin"))],
)
async def create_provider(payload: AIProviderCreate, db: AsyncSession = Depends(get_db)) -> dict:
    payload.validate_kind()
    existing = await db.execute(select(AIProvider).where(AIProvider.slug == payload.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="a provider with this slug already exists")
    provider = AIProvider(**payload.model_dump())
    db.add(provider)
    await db.commit()
    await db.refresh(provider)
    return {**provider.__dict__, "has_key": False}


@router.patch(
    "/ai/providers/{provider_id}",
    response_model=AIProviderRead,
    dependencies=[Depends(require_role("admin"))],
)
async def update_provider(
    provider_id: uuid.UUID, payload: AIProviderUpdate, db: AsyncSession = Depends(get_db)
) -> dict:
    provider = await db.get(AIProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(provider, field, value)
    await db.commit()
    await db.refresh(provider)
    return {**provider.__dict__, "has_key": bool(provider.secret_path)}


@router.post(
    "/ai/providers/{provider_id}/key",
    response_model=AIProviderRead,
    dependencies=[Depends(require_role("admin"))],
)
async def set_provider_key(
    provider_id: uuid.UUID, payload: AIProviderKeySet, db: AsyncSession = Depends(get_db)
) -> dict:
    provider = await db.get(AIProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    provider.secret_path = write_provider_key(provider.slug, payload.api_key)
    await db.commit()
    await db.refresh(provider)
    return {**provider.__dict__, "has_key": True}


@router.delete(
    "/ai/providers/{provider_id}/key",
    response_model=AIProviderRead,
    dependencies=[Depends(require_role("admin"))],
)
async def clear_provider_key(provider_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    provider = await db.get(AIProvider, provider_id)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    if provider.secret_path:
        delete_provider_key(provider.secret_path)
        provider.secret_path = None
        await db.commit()
        await db.refresh(provider)
    return {**provider.__dict__, "has_key": False}


# --------------------------------------------------------------------- #
# Agents - config editing is admin-only, reads are open to any authed user
# (same as the rest of the app's read/write split).
# --------------------------------------------------------------------- #
@router.get("/ai/agents", response_model=list[AIAgentRead])
async def list_agents(db: AsyncSession = Depends(get_db)) -> list[AIAgent]:
    result = await db.execute(select(AIAgent).order_by(AIAgent.slug))
    return list(result.scalars().all())


@router.post(
    "/ai/agents",
    response_model=AIAgentRead,
    status_code=201,
    dependencies=[Depends(require_role("admin"))],
)
async def create_agent(payload: AIAgentCreate, db: AsyncSession = Depends(get_db)) -> AIAgent:
    existing = await db.execute(select(AIAgent).where(AIAgent.slug == payload.slug))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="an agent with this slug already exists")
    agent = AIAgent(**payload.model_dump())
    db.add(agent)
    await db.commit()
    await db.refresh(agent)
    return agent


@router.get("/ai/agents/{agent_id}", response_model=AIAgentRead)
async def get_agent(agent_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AIAgent:
    agent = await db.get(AIAgent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


@router.patch(
    "/ai/agents/{agent_id}", response_model=AIAgentRead, dependencies=[Depends(require_role("admin"))]
)
async def update_agent(agent_id: uuid.UUID, payload: AIAgentUpdate, db: AsyncSession = Depends(get_db)) -> AIAgent:
    agent = await db.get(AIAgent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(agent, field, value)
    await db.commit()
    await db.refresh(agent)
    return agent


@router.delete(
    "/ai/agents/{agent_id}", status_code=204, dependencies=[Depends(require_role("admin"))]
)
async def delete_agent(agent_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    agent = await db.get(AIAgent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    if agent.slug == "coordinator":
        raise HTTPException(status_code=400, detail="the coordinator agent can't be deleted")
    await db.delete(agent)
    await db.commit()


# --------------------------------------------------------------------- #
# Ask Ops AI
# --------------------------------------------------------------------- #
@router.post("/ai/ask", response_model=AITaskRead, status_code=201)
async def ask_ops_ai(
    payload: AskRequest, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)
) -> AITask:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == payload.agent))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail=f"no agent named {payload.agent!r}")
    if not agent.enabled:
        raise HTTPException(status_code=409, detail=f"{agent.name} is disabled")

    task = AITask(
        agent_id=agent.id,
        requested_by=current_user.username,
        owner_user_id=current_user.id,
        source="web",
        conversation_key=payload.conversation_key,
        input_message=payload.message,
        status="queued",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    get_celery_client().send_task(
        "worker_ai.tasks.run_agent_task", args=[str(task.id)], queue="ai"
    )
    return task


@router.get("/ai/tasks", response_model=list[AITaskRead])
async def list_tasks(limit: int = Query(default=50, ge=1, le=500), db: AsyncSession = Depends(get_db)) -> list[AITask]:
    result = await db.execute(select(AITask).order_by(AITask.created_at.desc()).limit(limit))
    return list(result.scalars().all())


# USD per million tokens (input, output) - list prices, matched by model
# name prefix. An *estimate* for the usage panel, labelled as such in the
# UI; the stored facts are the token counts, never a cost. Unknown models
# get cost=null rather than a made-up number. Local Ollama is free.
_PRICE_PER_MTOK: list[tuple[str, tuple[float, float]]] = [
    ("claude-opus", (15.0, 75.0)),
    ("claude-sonnet", (3.0, 15.0)),
    ("claude-haiku", (0.8, 4.0)),
    ("gpt-4o-mini", (0.15, 0.6)),
    ("gpt-4o", (2.5, 10.0)),
    ("gpt-4.1", (2.0, 8.0)),
]


def _estimate_cost(provider_kind: str | None, model: str, input_tokens: int, output_tokens: int) -> float | None:
    if provider_kind == "ollama":
        return 0.0
    for prefix, (in_price, out_price) in _PRICE_PER_MTOK:
        if model.startswith(prefix):
            return round((input_tokens * in_price + output_tokens * out_price) / 1_000_000, 4)
    return None


@router.get("/ai/usage")
async def usage_by_day(days: int = Query(default=7, ge=1, le=90), db: AsyncSession = Depends(get_db)) -> dict:
    """Token usage per day per provider/model over the last `days` days,
    from ai_usage (one row per provider round trip - see AIUsage)."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    day = func.date_trunc("day", AIUsage.created_at)
    rows = (
        await db.execute(
            select(
                day.label("day"),
                AIUsage.provider_id,
                AIUsage.model,
                func.sum(AIUsage.input_tokens).label("input_tokens"),
                func.sum(AIUsage.output_tokens).label("output_tokens"),
                func.count(AIUsage.id).label("calls"),
            )
            .where(AIUsage.created_at >= since)
            .group_by(day, AIUsage.provider_id, AIUsage.model)
            .order_by(day)
        )
    ).all()
    providers = {p.id: p for p in (await db.execute(select(AIProvider))).scalars().all()}

    points = []
    for r in rows:
        provider = providers.get(r.provider_id)
        points.append(
            {
                "date": r.day.date().isoformat(),
                "provider_id": str(r.provider_id) if r.provider_id else None,
                "provider_slug": provider.slug if provider else "unknown",
                "provider_name": provider.display_name if provider else "Unknown",
                "model": r.model,
                "input_tokens": int(r.input_tokens or 0),
                "output_tokens": int(r.output_tokens or 0),
                "calls": int(r.calls or 0),
                "cost_usd": _estimate_cost(provider.kind if provider else None, r.model, int(r.input_tokens or 0), int(r.output_tokens or 0)),
            }
        )
    return {"days": days, "points": points}


@router.post("/ai/tasks/{task_id}/cancel", response_model=AITaskRead, dependencies=[Depends(require_role("operator"))])
async def cancel_task(task_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AITask:
    """Cooperative cancellation: an in-flight call finishes, then no new step starts."""
    task = (await db.execute(select(AITask).where(AITask.id == task_id).with_for_update())).scalar_one_or_none()
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    if task.status == "cancelled":
        return task
    if task.status not in ("queued", "running"):
        raise HTTPException(status_code=409, detail="task is already finished")
    task.status = "cancelled"
    task.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return task


@router.get("/ai/tasks/{task_id}", response_model=AITaskRead)
async def get_task(task_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AITask:
    task = await db.get(AITask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


# --------------------------------------------------------------------- #
# Findings
# --------------------------------------------------------------------- #
@router.get("/ai/findings", response_model=list[AIFindingRead])
async def list_findings(
    limit: int = Query(default=50, ge=1, le=500), db: AsyncSession = Depends(get_db)
) -> list[AIFinding]:
    result = await db.execute(select(AIFinding).order_by(AIFinding.created_at.desc()).limit(limit))
    return list(result.scalars().all())


# --------------------------------------------------------------------- #
# Pending AI Actions - approval workflow for write/execute tools.
# Reading is open to any authed user (same read/write split as the rest
# of the app); approving/rejecting requires at least operator, and a
# level-3 action additionally requires admin - checked explicitly below,
# not just via require_role, since the *level* (not just the route)
# decides who's allowed.
# --------------------------------------------------------------------- #
@router.get("/ai/actions", response_model=list[AIActionRead])
async def list_actions(
    status: str | None = None,
    task_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[AIAction]:
    """task_id is used by the Ask Ops AI chat page, to show a task's own
    pending approval request inline instead of sending the user to the
    Approvals page - see AIChat.tsx."""
    query = select(AIAction).order_by(AIAction.requested_at.desc())
    if status is not None:
        query = query.where(AIAction.status == status)
    if task_id is not None:
        query = query.where(AIAction.task_id == task_id)
    result = await db.execute(query.limit(limit))
    return list(result.scalars().all())


@router.post(
    "/ai/actions/{action_id}/approve",
    response_model=AIActionRead,
    dependencies=[Depends(require_role("operator"))],
)
async def approve_action(
    action_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)
) -> AIAction:
    action = await db.get(AIAction, action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="action not found")
    if action.task_id:
        parent = await db.get(AITask, action.task_id)
        if parent is not None and parent.status == "cancelled":
            raise HTTPException(status_code=409, detail="the task was cancelled")
    if action.status != "pending":
        raise HTTPException(status_code=409, detail=f"action is already {action.status}")
    if action.expires_at and action.expires_at < datetime.now(timezone.utc):
        action.status = "expired"
        await db.commit()
        raise HTTPException(status_code=409, detail="action has expired")
    if action.approval_level >= 3 and not role_at_least(current_user.role, "admin"):
        raise HTTPException(status_code=403, detail="a level-3 action requires an admin to approve")

    action.status = "approved"
    action.approved_by = current_user.username
    action.approved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(action)

    get_celery_client().send_task("worker_ai.tasks.execute_action_task", args=[str(action.id)], queue="ai")
    return action


@router.post(
    "/ai/actions/{action_id}/reject",
    response_model=AIActionRead,
    dependencies=[Depends(require_role("operator"))],
)
async def reject_action(
    action_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)
) -> AIAction:
    action = await db.get(AIAction, action_id)
    if action is None:
        raise HTTPException(status_code=404, detail="action not found")
    if action.status != "pending":
        raise HTTPException(status_code=409, detail=f"action is already {action.status}")
    if action.approval_level >= 3 and not role_at_least(current_user.role, "admin"):
        raise HTTPException(status_code=403, detail="a level-3 action requires an admin to reject")

    action.status = "rejected"
    action.approved_by = current_user.username
    action.approved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(action)
    return action


# --------------------------------------------------------------------- #
# Ops Floor live stream - see stream_router's module-level comment for why
# this isn't on `router` with the rest of these routes.
# --------------------------------------------------------------------- #
@stream_router.get("/ai/agents/stream")
async def stream_agent_events(token: str, db: AsyncSession = Depends(get_db)):
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")

    agents = (await db.execute(select(AIAgent))).scalars().all()

    async def event_source():
        # Replay current state first so a freshly opened Ops Floor shows
        # the truth immediately, not just whatever happens after connect.
        for agent in agents:
            yield f"data: {json.dumps({'agent': agent.slug, 'status': agent.status, 'activity': agent.current_task, 'target': None, 'task_id': None}, default=str)}\n\n"

        redis_client = get_redis_client()
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(AGENT_EVENTS_CHANNEL)
        try:
            while True:
                message = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True, timeout=30),
                    timeout=_STREAM_IDLE_TIMEOUT_SECONDS,
                )
                if message is None:
                    yield ": keepalive\n\n"
                    continue
                data = message["data"]
                yield f"data: {data.decode() if isinstance(data, bytes) else data}\n\n"
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'event_type': 'stream_timeout'})}\n\n"
        finally:
            await pubsub.unsubscribe(AGENT_EVENTS_CHANNEL)
            await redis_client.aclose()

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
