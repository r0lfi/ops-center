import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_role, user_for_token
from app.db.session import get_db
from app.services.action_approval import decide_action
from app.core.action_policy import ActionDenied
from app.models.ai import open_task_counts, PERSONAL_AGENT_TOOLS, AIAction, AIAgent, AIFinding, AIProvider, AITask, AIUsage
from app.models.ai_budget import AIBudgetReservation
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
    AgentStatusReport,
    AskWithContextRequest,
)
from app.core.provider_keys import encrypt_provider_key
from app.services.ai_secrets import delete_provider_key, write_provider_key
from app.services.auth import role_at_least
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
    provider.encrypted_key = encrypt_provider_key(payload.api_key)
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
    if provider.secret_path or provider.encrypted_key:
        # The key file is removed only on this node; with secret_path and the
        # encrypted copy cleared, a leftover file on another node is unused.
        if provider.secret_path:
            delete_provider_key(provider.secret_path)
        provider.secret_path = None
        provider.encrypted_key = None
        await db.commit()
        await db.refresh(provider)
    return {**provider.__dict__, "has_key": False}


def _check_personal_tools(personal: bool, tools: list[str] | None) -> None:
    extra = sorted(set(tools or []) - set(PERSONAL_AGENT_TOOLS)) if personal else []
    if extra:
        raise HTTPException(status_code=422, detail=f"a personal agent can only use {', '.join(PERSONAL_AGENT_TOOLS)}; not {', '.join(extra)}")


# Personal agents' conversations belong to the task owner alone.
_PERSONAL_AGENT_IDS = select(AIAgent.id).where(AIAgent.personal.is_(True))


async def _task_hidden(db: AsyncSession, task: AITask, user: User) -> bool:
    if getattr(task, "source", None) in ("collaboration", "incident"):
        return task.owner_user_id != user.id
    agent = await db.get(AIAgent, task.agent_id) if getattr(task, "agent_id", None) else None
    return bool(getattr(agent, "personal", False)) and task.owner_user_id != user.id


# --------------------------------------------------------------------- #
# Agents - config editing is admin-only, reads are open to any authed user
# (same as the rest of the app's read/write split).
# --------------------------------------------------------------------- #
@router.get("/ai/agents", response_model=list[AIAgentRead])
async def list_agents(db: AsyncSession = Depends(get_db)) -> list[AIAgent]:
    agents = list((await db.execute(select(AIAgent).order_by(AIAgent.slug))).scalars().all())
    counts = {row.agent_id: row for row in (await db.execute(open_task_counts())).all()}
    for agent in agents:
        row = counts.get(agent.id)
        agent.running_tasks = int(row.running) if row else 0
        agent.queued_tasks = int(row.queued) if row else 0
    return agents


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
    _check_personal_tools(payload.personal, payload.allowed_tools)
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
    _check_personal_tools(agent.personal, payload.allowed_tools)
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


@router.post(
    "/ai/agents/{agent_id}/report",
    response_model=AIAgentRead,
    dependencies=[Depends(require_role("operator"))],
)
async def report_agent_status(
    agent_id: uuid.UUID, payload: AgentStatusReport, db: AsyncSession = Depends(get_db)
) -> AIAgent:
    """State report from an external agent (e.g. an external runtime such as opencode).

    Only agents created with runtime="external" accept reports; native agent
    state stays owned by ops-ai-worker. The Ops Floor receives the same event
    shape the worker publishes.
    """
    agent = await db.get(AIAgent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    if agent.runtime != "external":
        raise HTTPException(status_code=409, detail="only external agents report their own state")
    if not agent.enabled:
        raise HTTPException(status_code=409, detail=f"{agent.name} is disabled")
    agent.status = payload.status
    agent.current_task = payload.activity
    agent.error_message = payload.activity if payload.status == "error" else None
    agent.last_activity_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(agent)
    try:
        await get_redis_client().publish(AGENT_EVENTS_CHANNEL, json.dumps({
            "agent": agent.slug, "status": agent.status, "activity": agent.current_task,
            "target": payload.target, "task_id": None, "ts": datetime.now(timezone.utc).timestamp(),
        }))
    except Exception:  # noqa: BLE001 - the DB row is authoritative, as in worker_ai/events.py
        pass
    return agent


# --------------------------------------------------------------------- #
# Ask Ops AI
# --------------------------------------------------------------------- #
# The web UI hides this block when it shows the question again; history keeps it.
ASK_CONTEXT_MARK = "\n\n---\nPage context"


def _context_block(context) -> str:
    """The page the question was asked from, appended visibly to the question."""
    if context is None:
        return ""
    from app.core.memory_rules import SECRET_RE
    lines = [f"Page: {context.page} ({context.path})"] + [f"- {i.label}: {i.value}" for i in context.items]
    text = "\n".join(" ".join(line.split()) for line in lines)
    if SECRET_RE.search(text):
        raise HTTPException(status_code=422, detail="the page context looks like it contains a credential; ask without it")
    return (ASK_CONTEXT_MARK + " (identifiers from the Ops Center page the user asked from; read the data with your tools, "
            "and only where the user has access):\n" + text)


@router.post("/ai/ask", response_model=AITaskRead, status_code=201)
async def ask_ops_ai(
    payload: AskWithContextRequest, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)
) -> AITask:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == payload.agent))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail=f"no agent named {payload.agent!r}")
    if not agent.enabled:
        raise HTTPException(status_code=409, detail=f"{agent.name} is disabled")
    if agent.runtime != "native":
        raise HTTPException(status_code=409, detail=f"{agent.name} runs outside Ops Center; ask it there")

    task = AITask(
        agent_id=agent.id,
        requested_by=current_user.username,
        owner_user_id=current_user.id,
        source="web",
        conversation_key=payload.conversation_key,
        input_message=payload.message + _context_block(payload.context),
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
async def list_tasks(limit: int = Query(default=50, ge=1, le=500), agent: str | None = Query(default=None, max_length=50),
                     mine: bool = False, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)) -> list[AITask]:
    visible = or_(and_(AITask.source.notin_(("collaboration", "incident")), AITask.agent_id.notin_(_PERSONAL_AGENT_IDS)),
                  AITask.owner_user_id == current_user.id)
    query = select(AITask).where(visible)
    if agent:
        query = query.join(AIAgent, AIAgent.id == AITask.agent_id).where(AIAgent.slug == agent)
    if mine:
        query = query.where(AITask.owner_user_id == current_user.id)
    result = await db.execute(query.order_by(AITask.created_at.desc()).limit(limit))
    return list(result.scalars().all())


# Keep the historic chart and enforced ledger on the same reviewed prices.
def _estimate_cost(provider_kind: str | None, model: str, input_tokens: int, output_tokens: int) -> float | None:
    from app.core.ai_pricing import rates, token_cost, UnknownPrice
    try:
        return float(token_cost(input_tokens, output_tokens, *rates(provider_kind, model)))
    except UnknownPrice:
        return None


@router.get("/ai/usage")
async def usage_by_day(days: int = Query(default=7, ge=1, le=90), db: AsyncSession = Depends(get_db)) -> dict:
    """Token usage per day per provider/model over the last `days` days,
    from ai_usage (one row per provider round trip - see AIUsage)."""
    since = datetime.now(timezone.utc) - timedelta(days=days)
    day = func.date_trunc("day", AIUsage.created_at)
    legacy = AIUsage.reservation_id.is_(None)
    rows = (
        await db.execute(
            select(
                day.label("day"), AIUsage.provider_id, AIUsage.model,
                func.sum(AIUsage.input_tokens).label("input_tokens"),
                func.sum(AIUsage.output_tokens).label("output_tokens"),
                func.count(AIUsage.id).label("calls"),
                func.count(AIUsage.id).filter(legacy).label("estimated_calls"),
                func.sum(AIUsage.input_tokens).filter(legacy).label("estimated_input"),
                func.sum(AIUsage.output_tokens).filter(legacy).label("estimated_output"),
                func.sum(AIBudgetReservation.billed_usd).label("stored_cost"),
                func.count(AIUsage.id).filter(and_(AIUsage.reservation_id.is_not(None),
                    AIBudgetReservation.billed_usd.is_(None))).label("unsettled_calls"),
            )
            .outerjoin(AIBudgetReservation, AIBudgetReservation.id == AIUsage.reservation_id)
            .where(AIUsage.created_at >= since)
            .group_by(day, AIUsage.provider_id, AIUsage.model)
            .order_by(day)
        )
    ).all()
    providers = {p.id: p for p in (await db.execute(select(AIProvider))).scalars().all()}

    points = []
    for r in rows:
        provider = providers.get(r.provider_id)
        estimate = _estimate_cost(provider.kind if provider else None, r.model,
            int(r.estimated_input or 0), int(r.estimated_output or 0)) if r.estimated_calls else 0.0
        # Linked rows use their immutable stored price, even after a provider
        # model/price changes. Unknown outcomes are not shown as zero cost.
        known = not r.unsettled_calls and estimate is not None
        basis = "unavailable" if not known else "estimated" if r.estimated_calls == r.calls else "mixed" if r.estimated_calls else "stored"
        points.append({
            "date": r.day.date().isoformat(),
            "provider_id": str(r.provider_id) if r.provider_id else None,
            "provider_slug": provider.slug if provider else "unknown",
            "provider_name": provider.display_name if provider else "Unknown",
            "model": r.model,
            "input_tokens": int(r.input_tokens or 0), "output_tokens": int(r.output_tokens or 0),
            "calls": int(r.calls),
            "cost_usd": float(r.stored_cost or 0) + estimate if known else None,
            "cost_basis": basis,
            "estimated_calls": int(r.estimated_calls), "unsettled_calls": int(r.unsettled_calls),
        })
    return {"days": days, "points": points}


@router.post("/ai/tasks/{task_id}/cancel", response_model=AITaskRead, dependencies=[Depends(require_role("operator"))])
async def cancel_task(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)) -> AITask:
    """Cooperative cancellation: an in-flight call finishes, then no new step starts."""
    task = (await db.execute(select(AITask).where(AITask.id == task_id).with_for_update())).scalar_one_or_none()
    if task is None or await _task_hidden(db, task, current_user):
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
async def get_task(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)) -> AITask:
    task = await db.get(AITask, task_id)
    if task is None or await _task_hidden(db, task, current_user):
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
    current_user: User = Depends(get_current_user),
) -> list[AIAction]:
    """task_id is used by the Ask Ops AI chat page, to show a task's own
    pending approval request inline instead of sending the user to the
    Approvals page - see AIChat.tsx."""
    # Incident context can include private troubleshooting memory. Check the
    # parent as well as the action source, and require consistent ownership.
    query = (select(AIAction).outerjoin(AITask, AITask.id == AIAction.task_id)
             .where(or_(
                 and_(AIAction.source != "incident", or_(AITask.id.is_(None), AITask.source != "incident")),
                 and_(AIAction.owner_user_id == current_user.id, AITask.owner_user_id == current_user.id),
             )).order_by(AIAction.requested_at.desc()))
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
    try:
        return await decide_action(db, current_user, action_id=action_id, approve=True)
    except ActionDenied as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc



@router.post(
    "/ai/actions/{action_id}/reject",
    response_model=AIActionRead,
    dependencies=[Depends(require_role("operator"))],
)
async def reject_action(
    action_id: uuid.UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)
) -> AIAction:
    try:
        return await decide_action(db, current_user, action_id=action_id, approve=False)
    except ActionDenied as exc:
        await db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc



# --------------------------------------------------------------------- #
# Ops Floor live stream - see stream_router's module-level comment for why
# this isn't on `router` with the rest of these routes.
# --------------------------------------------------------------------- #
@stream_router.get("/ai/agents/stream")
async def stream_agent_events(token: str, db: AsyncSession = Depends(get_db)):
    if await user_for_token(db, token) is None:
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
