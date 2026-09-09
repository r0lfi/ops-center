"""User-owned archive and memory endpoints; no cross-user/admin override."""
import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.models.ai_memory import AIMemory, AIMemoryPreference
from app.models.user import User
from app.schemas.ai import AITaskRead

router = APIRouter()


class MemoryWrite(BaseModel):
    agent_id: uuid.UUID | None = None
    key: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.-]+$")
    content: str = Field(min_length=1, max_length=2000)


class PreferenceWrite(BaseModel):
    enabled: bool


def memory_read(row):
    return {"id": row.id, "agent_id": row.agent_id, "key": row.key, "content": row.content, "source_task_id": row.source_task_id, "updated_at": row.updated_at}


@router.get("/ai/memory")
async def list_memory(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    preference = await db.get(AIMemoryPreference, user.id)
    rows = (await db.execute(select(AIMemory).where(AIMemory.user_id == user.id).order_by(AIMemory.updated_at.desc()))).scalars()
    return {"enabled": preference.enabled if preference else True, "items": [memory_read(row) for row in rows]}


@router.put("/ai/memory/preferences")
async def set_preference(payload: PreferenceWrite, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await db.execute(insert(AIMemoryPreference).values(user_id=user.id, enabled=payload.enabled).on_conflict_do_update(index_elements=["user_id"], set_={"enabled": payload.enabled}))
    await db.commit()
    return {"enabled": payload.enabled}


@router.put("/ai/memory")
async def save_memory(payload: MemoryWrite, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    if not payload.content.strip():
        raise HTTPException(422, "memory cannot be blank")
    if payload.agent_id is not None and await db.get(AIAgent, payload.agent_id) is None:
        raise HTTPException(404, "agent not found")
    await db.execute(insert(AIMemory).values(user_id=user.id, agent_id=payload.agent_id, key=payload.key, content=payload.content.strip()).on_conflict_do_update(constraint="uq_ai_memory_user_key", set_={"content": payload.content.strip(), "source_task_id": None, "updated_at": func.now()}))
    await db.commit()
    return {"ok": True}


@router.delete("/ai/memory/{memory_id}", status_code=204)
async def delete_memory(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = (await db.execute(select(AIMemory).where(AIMemory.id == memory_id, AIMemory.user_id == user.id))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "memory not found")
    await db.delete(row)
    await db.commit()


@router.get("/ai/history")
async def history(
    agent: str | None = None, conversation_key: str | None = Query(default=None, max_length=200),
    q: str = Query(default="", max_length=200), offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user),
):
    conditions = [AITask.owner_user_id == user.id, AITask.source == "web"]
    if agent:
        conditions.append(AIAgent.slug == agent)
    if conversation_key:
        conditions.append(AITask.conversation_key == conversation_key)
    if q.strip():
        conditions.append(or_(AITask.input_message.icontains(q.strip(), autoescape=True), AITask.response_message.icontains(q.strip(), autoescape=True)))
    base = select(AITask, AIAgent.slug).join(AIAgent).where(*conditions)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await db.execute(base.order_by(AITask.created_at.desc(), AITask.id.desc()).offset(offset).limit(limit))).all()
    return {"total": total, "items": [{"agent": slug, "task": AITaskRead.model_validate(task)} for task, slug in rows]}
