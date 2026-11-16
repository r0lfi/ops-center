"""Owner-only "Import & Organize": analyze a large text into memory proposals, review, save all.

Nothing reaches ai_memories until the owner saves. Saving validates every item
first and writes all or nothing; new notes go to the scope the owner chose
(the personal agent's own scope by default), and existing notes change only
through an explicit update, with their previous state kept for undo.
"""
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.ai_pricing import UnknownPrice, rates, token_cost
from app.core.memory_rules import reserved_prefix
from app.db.session import get_db
from app.models.ai import AIAgent
from app.models.ai_memory import AIMemory, AIMemoryOrganizeJob, AIMemoryPreference
from app.models.user import User
from app.services.celery_client import get_celery_client
from app.services.memory_organize import MAX_INPUT, OUTPUT_CAP, PROMPT_TOKENS, split_sections
from app.services.memory_store import MAX_NOTE, clean_category, note_problem, snapshot

router = APIRouter()


class OrganizeItem(BaseModel):
    action: Literal["create", "update", "skip"]
    key: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=MAX_NOTE)
    category: str | None = Field(default=None, max_length=80)
    kind: Literal["fact", "plan", "history"] | None = None
    scope: Literal["nova", "shared"]
    target_id: uuid.UUID | None = None


class OrganizeApply(BaseModel):
    items: list[OrganizeItem] = Field(max_length=1000)


def job_read(job, *, proposals=True):
    sections = [{k: s.get(k) for k in ("index", "chars", "status", "error", "secrets", "dropped")} for s in job.sections]
    return {"id": job.id, "status": job.status, "source_name": job.source_name, "created_at": job.created_at,
            "finished_at": job.finished_at, "sections": sections, "proposals": job.proposals if proposals else None,
            "proposal_count": len(job.proposals or [])}


async def _personal_agent(db) -> AIAgent:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "nova", AIAgent.personal.is_(True)))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "nova is not installed")
    await db.refresh(agent, ["provider"])
    return agent


async def _job(db, job_id, user, *, lock=False) -> AIMemoryOrganizeJob:
    query = select(AIMemoryOrganizeJob).where(AIMemoryOrganizeJob.id == job_id, AIMemoryOrganizeJob.user_id == user.id)
    job = (await db.execute(query.with_for_update() if lock else query)).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, "organize job not found")
    return job


def _estimate(agent, chars: int, sections: int) -> dict:
    input_tokens, output_tokens = int(chars / 3.5) + sections * PROMPT_TOKENS, sections * OUTPUT_CAP
    provider = agent.provider
    estimate = {"sections": sections, "input_tokens": input_tokens, "output_tokens": output_tokens,
                "provider": provider.display_name if provider else None, "local": bool(provider and provider.kind in ("ollama", "openai_compatible")),
                "cost_usd": None}
    if provider is not None:
        try:
            estimate["cost_usd"] = float(token_cost(input_tokens, output_tokens, *rates(provider.kind, agent.model or provider.default_model, provider.base_url)))
        except UnknownPrice:
            pass
    return estimate


@router.post("/ai/memory/organize")
async def start_organize(text: str | None = Form(default=None), file: UploadFile | None = File(default=None), source_name: str = Form(default="", max_length=200),
                         db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _personal_agent(db)
    preference = await db.get(AIMemoryPreference, user.id)
    if preference is not None and not preference.enabled:
        raise HTTPException(409, "Turn on long-term memory first.")
    if not agent.enabled or agent.provider is None or not agent.provider.enabled:
        raise HTTPException(409, "Nova is disabled or has no enabled provider.")
    if file is not None:
        data = await file.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise HTTPException(413, "The file is larger than 1 MB.")
        text, source_name = data.decode("utf-8", errors="replace"), source_name or (file.filename or "")[:200]
    if not text or not text.strip():
        raise HTTPException(422, "Paste a text or choose a .txt/.md file.")
    if len(text) > MAX_INPUT:
        raise HTTPException(413, "The text is larger than 1 MB.")
    sections = split_sections(text)
    job = AIMemoryOrganizeJob(user_id=user.id, agent_id=agent.id, status="queued", source_name=source_name or "Pasted text",
                              input_text=text, sections=[{"index": i, "chars": len(s), "status": "pending"} for i, s in enumerate(sections)],
                              proposals=[])
    db.add(job)
    await db.commit()
    get_celery_client().send_task("worker_ai.tasks.organize_memory", args=[str(job.id)], queue="ai")
    return {**job_read(job), "estimate": _estimate(agent, len(text), len(sections))}


@router.get("/ai/memory/organize")
async def list_organize(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    jobs = (await db.execute(select(AIMemoryOrganizeJob).where(AIMemoryOrganizeJob.user_id == user.id)
                             .order_by(AIMemoryOrganizeJob.created_at.desc()).limit(20))).scalars()
    return {"items": [job_read(job, proposals=False) for job in jobs]}


@router.get("/ai/memory/organize/{job_id}")
async def get_organize(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return job_read(await _job(db, job_id, user))


@router.post("/ai/memory/organize/{job_id}/retry")
async def retry_organize(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    job = await _job(db, job_id, user, lock=True)
    if job.status in ("queued", "running"):
        raise HTTPException(409, "The analysis is still running.")
    if all(s.get("status") == "done" for s in job.sections):
        raise HTTPException(409, "Every section is already analyzed.")
    # The worker analyzes pending sections only; a retry re-arms the failed ones.
    job.sections = [{**s, "status": "pending"} if s.get("status") == "failed" else dict(s) for s in job.sections]
    job.status = "queued"
    await db.commit()
    get_celery_client().send_task("worker_ai.tasks.organize_memory", args=[str(job.id)], queue="ai")
    return job_read(job)


@router.delete("/ai/memory/organize/{job_id}", status_code=204)
async def discard_organize(job_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await db.delete(await _job(db, job_id, user, lock=True))
    await db.commit()


@router.post("/ai/memory/organize/{job_id}/apply")
async def apply_organize(job_id: uuid.UUID, payload: OrganizeApply, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    job = await _job(db, job_id, user, lock=True)
    if job.status in ("queued", "running"):
        raise HTTPException(409, "Wait for the analysis to finish.")
    items = [i for i in payload.items if i.action != "skip"]
    targets = {n.id: n for n in (await db.execute(select(AIMemory).where(
        AIMemory.user_id == user.id, AIMemory.id.in_([i.target_id for i in items if i.target_id]))
        .with_for_update())).scalars()} if any(i.target_id for i in items) else {}
    existing = {(n.agent_id, n.key): n for n in (await db.execute(select(AIMemory).where(
        AIMemory.user_id == user.id, AIMemory.key.in_([i.key for i in items])))).scalars()} if items else {}
    errors, planned, claimed = [], [], set()
    for index, item in enumerate(payload.items):
        if item.action == "skip":
            continue
        agent_id = job.agent_id if item.scope == "nova" else None
        target = targets.get(item.target_id) if item.target_id else None
        problem = note_problem(item.key, item.content, kind=item.kind, allow_reserved=reserved_prefix(target.key) if target else None)
        try:
            category = clean_category(item.category)
        except ValueError as exc:
            problem = problem or str(exc)
        if item.action == "update" and target is None:
            problem = problem or "The note to update no longer exists."
        clash = existing.get((agent_id, item.key))
        if not problem and clash is not None and clash is not target:
            problem = f"A note with key {item.key!r} already exists in that scope; update it or choose another key."
        if not problem and (agent_id, item.key) in claimed:
            problem = f"Two items use key {item.key!r} in the same scope; merge them first."
        if problem:
            errors.append({"index": index, "key": item.key, "error": problem})
            continue
        claimed.add((agent_id, item.key))
        planned.append((item, target, agent_id, category))
    if errors:
        raise HTTPException(422, {"message": "Nothing was saved; fix these items.", "errors": errors})
    created = updated = 0
    for item, target, agent_id, category in planned:
        if target is not None:
            await db.execute(snapshot(target, "scope" if agent_id != target.agent_id else "update", "import"))
            target.key, target.content, target.category, target.kind, target.agent_id = item.key, item.content.strip(), category, item.kind, agent_id
            target.updated_at = datetime.now(timezone.utc)
            updated += 1
        else:
            db.add(AIMemory(user_id=user.id, agent_id=agent_id, key=item.key, content=item.content.strip(), category=category, kind=item.kind))
            created += 1
    await db.delete(job)  # the pasted text is not kept once its proposals are saved
    await db.commit()
    return {"created": created, "updated": updated, "skipped": len(payload.items) - created - updated}
