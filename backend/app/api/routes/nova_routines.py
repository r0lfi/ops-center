"""Owner-only proactive routines for nova (see app/core/nova_routines.py, worker_ai/ai/routines.py).

The owner creates, edits, pauses and deletes routines, sets quiet hours and a
daily cap, and turns proactive runs on (off by default). The worker starts
due routines; this API only stores them, lists their runs and queues a
manual "Run now".
"""
import uuid
from datetime import datetime, time, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.nova_routines import MAX_INSTRUCTION, MAX_NAME, MAX_PER_DAY, MAX_ROUTINES, next_due, routine_problem, talk_room
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.models.ai_memory import AIMemoryPreference
from app.models.nova import NovaProactiveSettings, NovaRoutine, NovaRoutineRun
from app.models.user import User
from app.services.celery_client import get_celery_client

router = APIRouter()
RUN_LIMIT = 30
RESPONSE_CHARS = 4000
Channel = Literal["web", "talk"]


class RoutineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    schedule: str = Field(min_length=1, max_length=100)
    instruction: str = Field(min_length=1, max_length=MAX_INSTRUCTION)
    channel: Channel = "web"
    enabled: bool = True


class RoutineUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    schedule: str | None = Field(default=None, min_length=1, max_length=100)
    instruction: str | None = Field(default=None, min_length=1, max_length=MAX_INSTRUCTION)
    channel: Channel | None = None
    enabled: bool | None = None


class ProactiveUpdate(BaseModel):
    enabled: bool
    quiet_start: time
    quiet_end: time
    max_per_day: int = Field(ge=1, le=MAX_PER_DAY)


async def _nova(db) -> AIAgent:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "nova", AIAgent.personal.is_(True)))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "nova is not installed")
    return agent


async def _routine(db, routine_id, user) -> NovaRoutine:
    routine = await db.get(NovaRoutine, routine_id)
    if routine is None or routine.user_id != user.id:
        raise HTTPException(404, "routine not found")
    return routine


def _check(name, schedule, instruction):
    problem = routine_problem(name, schedule, instruction)
    if problem:
        raise HTTPException(422, problem)


def routine_read(routine, now):
    return {"id": routine.id, "name": routine.name, "schedule": routine.schedule, "instruction": routine.instruction,
            "channel": routine.channel, "enabled": routine.enabled, "last_run_at": routine.last_run_at,
            "next_run_at": next_due(routine.schedule, now) if routine.enabled else None, "created_at": routine.created_at}


def settings_read(row):
    row = row or NovaProactiveSettings(enabled=False, quiet_start=time(22, 0), quiet_end=time(7, 0), max_per_day=3)
    return {"enabled": row.enabled, "quiet_start": row.quiet_start.strftime("%H:%M"), "quiet_end": row.quiet_end.strftime("%H:%M"),
            "max_per_day": row.max_per_day}


@router.get("/ai/nova/routines")
async def list_routines(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    now = datetime.now(timezone.utc)
    preference = await db.get(AIMemoryPreference, user.id)
    routines = (await db.execute(select(NovaRoutine).where(NovaRoutine.user_id == user.id)
                                 .order_by(NovaRoutine.created_at))).scalars().all()
    rows = (await db.execute(
        select(NovaRoutineRun, NovaRoutine.name, AITask.status, AITask.response_message, AITask.error_message, AITask.completed_at)
        .join(NovaRoutine, NovaRoutine.id == NovaRoutineRun.routine_id)
        .outerjoin(AITask, AITask.id == NovaRoutineRun.task_id)
        .where(NovaRoutineRun.user_id == user.id).order_by(NovaRoutineRun.created_at.desc()).limit(RUN_LIMIT))).all()
    runs = [{"id": run.id, "routine_id": run.routine_id, "routine_name": name, "due_at": run.due_at, "manual": run.manual,
             "channel": run.channel, "status": run.status, "reason": run.reason, "task_id": run.task_id,
             "task_status": task_status, "response": (response or "")[:RESPONSE_CHARS] or None, "error": error,
             "completed_at": completed_at, "delivered_at": run.delivered_at, "delivery_error": run.delivery_error}
            for run, name, task_status, response, error, completed_at in rows]
    return {"settings": settings_read(await db.get(NovaProactiveSettings, user.id)),
            "memory_enabled": preference is None or preference.enabled,
            "talk_room": talk_room(user.id, agent.slug) is not None, "timezone": get_settings().tz,
            "max_routines": MAX_ROUTINES, "routines": [routine_read(r, now) for r in routines], "runs": runs}


@router.put("/ai/nova/proactive")
async def update_proactive(payload: ProactiveUpdate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _nova(db)
    row = await db.get(NovaProactiveSettings, user.id)
    if row is None:
        row = NovaProactiveSettings(user_id=user.id)
        db.add(row)
    row.enabled, row.quiet_start, row.quiet_end, row.max_per_day = (
        payload.enabled, payload.quiet_start.replace(second=0, microsecond=0, tzinfo=None),
        payload.quiet_end.replace(second=0, microsecond=0, tzinfo=None), payload.max_per_day)
    await db.commit()
    return settings_read(row)


@router.post("/ai/nova/routines", status_code=201)
async def create_routine(payload: RoutineCreate, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    _check(payload.name, payload.schedule, payload.instruction)
    count = await db.scalar(select(func.count()).select_from(NovaRoutine).where(NovaRoutine.user_id == user.id))
    if count >= MAX_ROUTINES:
        raise HTTPException(409, f"At most {MAX_ROUTINES} routines.")
    routine = NovaRoutine(user_id=user.id, agent_id=agent.id, name=payload.name.strip(), schedule=" ".join(payload.schedule.split()),
                            instruction=payload.instruction.strip(), channel=payload.channel, enabled=payload.enabled)
    db.add(routine)
    await db.commit()
    await db.refresh(routine)
    return routine_read(routine, datetime.now(timezone.utc))


@router.patch("/ai/nova/routines/{routine_id}")
async def update_routine(routine_id: uuid.UUID, payload: RoutineUpdate, db: AsyncSession = Depends(get_db),
                         user: User = Depends(get_current_user)):
    routine = await _routine(db, routine_id, user)
    changes = payload.model_dump(exclude_unset=True)
    if "enabled" in changes and changes["enabled"] is None or "channel" in changes and changes["channel"] is None:
        raise HTTPException(422, "enabled and channel cannot be empty")
    name = (changes.get("name") or routine.name).strip()
    schedule = " ".join((changes.get("schedule") or routine.schedule).split())
    instruction = (changes.get("instruction") or routine.instruction).strip()
    _check(name, schedule, instruction)
    routine.name, routine.schedule, routine.instruction = name, schedule, instruction
    routine.channel = changes.get("channel") or routine.channel
    if "enabled" in changes:
        routine.enabled = changes["enabled"]
    await db.commit()
    await db.refresh(routine)
    return routine_read(routine, datetime.now(timezone.utc))


@router.delete("/ai/nova/routines/{routine_id}", status_code=204)
async def delete_routine(routine_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    routine = await _routine(db, routine_id, user)
    await db.delete(routine)
    await db.commit()


@router.post("/ai/nova/routines/{routine_id}/run", status_code=202)
async def run_routine(routine_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    routine = await _routine(db, routine_id, user)
    preference = await db.get(AIMemoryPreference, user.id)
    if preference is not None and not preference.enabled:
        raise HTTPException(409, "Memory is off, so nova runs no routines.")
    settings = await db.get(NovaProactiveSettings, user.id)
    if settings is None or not settings.enabled:
        raise HTTPException(409, "Turn proactive runs on first.")
    get_celery_client().send_task("worker_ai.tasks.run_nova_routine", args=[str(routine.id), str(user.id)], queue="ai")
    return {"queued": True}
