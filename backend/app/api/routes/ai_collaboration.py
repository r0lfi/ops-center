"""Owner-only boards and versioned admin policy."""
import uuid
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import get_current_user, require_role
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.models.ai_collaboration import AICollaborationSettings, AICollaborationBoard, AICollaborationPost, AICollaborationDailyUsage
from app.models.audit import AuditLogEntry
from app.models.user import User
from app.schemas.ai_collaboration import CollaborationPolicy, SettingsWrite, READ_TOOLS

from app.schemas.ai import AskRequest
from app.services.celery_client import get_celery_client

router = APIRouter()

def board_read(row):
    return {name: getattr(row, name) for name in ("task_id", "status", "stop_reason", "participants", "charged_tokens", "actual_tokens", "model_calls", "message_count", "created_at", "expires_at", "policy")}

@router.get("/ai/collaboration/settings")
async def settings(db: AsyncSession = Depends(get_db)):
    row = await db.get(AICollaborationSettings, 1)
    day = await db.get(AICollaborationDailyUsage, datetime.now(timezone.utc).date())
    return {"revision": row.revision, "policy": CollaborationPolicy.model_validate(row.policy), "tools": READ_TOOLS, "daily_charged_tokens": day.charged_tokens if day else 0}

@router.put("/ai/collaboration/settings", dependencies=[Depends(require_role("admin"))])
async def update_settings(payload: SettingsWrite, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    known = set((await db.execute(select(AIAgent.slug))).scalars())
    if set(payload.policy.agents) - known:
        raise HTTPException(422, "Unknown agent in collaboration policy")
    row = (await db.execute(select(AICollaborationSettings).where(AICollaborationSettings.id == 1).with_for_update())).scalar_one()
    if row.revision != payload.revision:
        raise HTTPException(409, "Settings changed in another session. Reload before saving.")
    before = row.policy
    row.policy = payload.policy.model_dump()
    row.revision += 1
    db.add(AuditLogEntry(user=user.username, action="PUT", target="/api/ai/collaboration/settings", parameters={"before": before, "after": row.policy, "revision": row.revision}, result="200"))
    await db.commit()
    return await settings(db)

@router.get("/ai/collaboration/boards")
async def boards(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(AICollaborationBoard, AITask.input_message, AITask.status).join(AITask, AITask.id == AICollaborationBoard.task_id).where(AICollaborationBoard.owner_user_id == user.id).order_by(AICollaborationBoard.created_at.desc()).offset(offset).limit(limit))).all()
    return [{"board": board_read(board), "question": question[:500], "task_status": status} for board, question, status in rows]

async def owned_board(task_id, db, user, lock=False):
    query = select(AICollaborationBoard).where(AICollaborationBoard.task_id == task_id, AICollaborationBoard.owner_user_id == user.id)
    row = (await db.execute(query.with_for_update() if lock else query)).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Collaboration board not found")
    return row

@router.get("/ai/collaboration/boards/{task_id}")
async def detail(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await owned_board(task_id, db, user)
    posts = (await db.execute(select(AICollaborationPost).where(AICollaborationPost.task_id == task_id).order_by(AICollaborationPost.sequence))).scalars()
    task = await db.get(AITask, task_id)
    return {"board": board_read(row), "question": task.input_message, "task_status": task.status, "posts": [{k: getattr(p, k) for k in ("id", "sequence", "agent", "recipient", "kind", "content", "created_at")} for p in posts]}

@router.post("/ai/collaboration/boards/{task_id}/stop")
async def stop(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await owned_board(task_id, db, user, lock=True)
    if row.status in ("queued", "running"):
        row.status = "stopped"
        row.stop_reason = "Stopped by task owner"
        db.add(AuditLogEntry(user=user.username, action="POST", target=f"/api/ai/collaboration/boards/{task_id}/stop", parameters={}, result="200"))
        await db.commit()
    return board_read(row)

@router.post("/ai/collaboration/boards", status_code=201)
async def start(payload: AskRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    config = (await db.execute(select(AICollaborationSettings).where(AICollaborationSettings.id == 1).with_for_update())).scalar_one()
    policy = CollaborationPolicy.model_validate(config.policy)
    permission = policy.agents.get(payload.agent)
    if not policy.enabled or not permission or not permission.read:
        raise HTTPException(403, "Collaboration is disabled or the lead agent is not permitted")
    count = await db.scalar(select(func.count()).select_from(AICollaborationBoard).join(AITask, AITask.id == AICollaborationBoard.task_id).where(AICollaborationBoard.status.in_(("queued", "running")), AITask.status.in_(("queued", "running"))))
    if count >= policy.max_active_investigations:
        raise HTTPException(429, "Maximum active collaboration investigations reached")
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == payload.agent, AIAgent.enabled.is_(True)))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(422, "Lead agent is unavailable")
    task = AITask(agent_id=agent.id, requested_by=user.username, owner_user_id=user.id,
                  source="collaboration", input_message=payload.message, status="queued")
    db.add(task)
    await db.flush()
    board = AICollaborationBoard(task_id=task.id, owner_user_id=user.id, policy=policy.model_dump(),
        participants=[agent.slug], requests=[], status="queued", charged_tokens=0, actual_tokens=0,
        model_calls=0, message_count=0, expires_at=datetime.now(timezone.utc) + timedelta(seconds=policy.max_seconds))
    db.add(board)
    await db.commit()
    try:
        get_celery_client().send_task("worker_ai.tasks.run_agent_task", args=[str(task.id)], queue="ai")
    except Exception:
        board.status, board.stop_reason = "failed", "Could not enqueue collaboration"
        task.status, task.error_message = "failed", board.stop_reason
        await db.commit()
        raise HTTPException(503, board.stop_reason)
    return {"task_id": task.id}
