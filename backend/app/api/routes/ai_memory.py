"""User-owned archive and memory endpoints; no cross-user/admin override.

Scope is the note's agent_id: NULL is shared with all the owner's agents, an
agent id keeps it with that agent only (Nova only). Every change to an
existing note stores its previous state in ai_memory_versions first, so it can
be undone (app/services/memory_store.py).
"""
import uuid
from datetime import date, datetime, timezone
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.core.memory_rules import reserved_prefix
from app.models.ai_memory import AIMemory, AIMemoryPreference, AIMemorySuggestion, AIMemoryVersion
from app.models.user import User
from app.schemas.ai import AITaskRead
from app.services.memory_store import MAX_NOTE, clean_category, duplicate_pairs, note_problem, snapshot

router = APIRouter()
Kind = Literal["fact", "plan", "history"]


class MemoryWrite(BaseModel):
    agent_id: uuid.UUID | None = None
    key: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_.-]+$")
    content: str = Field(min_length=1, max_length=MAX_NOTE)
    category: str | None = Field(default=None, max_length=80)
    kind: Kind | None = None


class MemoryEdit(BaseModel):
    """Only the fields sent are changed; send agent_id null to make a note shared."""
    key: str | None = Field(default=None, min_length=1, max_length=100)
    content: str | None = Field(default=None, min_length=1, max_length=MAX_NOTE)
    category: str | None = Field(default=None, max_length=80)
    kind: Kind | None = None
    agent_id: uuid.UUID | None = None


class MemoryMerge(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=2, max_length=20)
    key: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=MAX_NOTE)
    category: str | None = Field(default=None, max_length=80)
    kind: Kind | None = None
    agent_id: uuid.UUID | None = None


class PreferenceWrite(BaseModel):
    enabled: bool


def memory_read(row):
    return {"id": row.id, "agent_id": row.agent_id, "key": row.key, "content": row.content, "category": row.category, "kind": row.kind,
            "source_task_id": row.source_task_id, "created_at": row.created_at, "updated_at": row.updated_at}


def version_read(row):
    return {"id": row.id, "memory_id": row.memory_id, "agent_id": row.agent_id, "key": row.key, "category": row.category,
            "kind": row.kind, "content": row.content, "change": row.change, "changed_by": row.changed_by, "created_at": row.created_at}


def _checked(key, content, category, kind, *, allow_reserved=None):
    problem = note_problem(key, content, kind=kind, allow_reserved=allow_reserved)
    if problem:
        raise HTTPException(422, problem)
    try:
        return clean_category(category)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


async def _agent_exists(db, agent_id):
    if agent_id is not None and await db.get(AIAgent, agent_id) is None:
        raise HTTPException(404, "agent not found")


async def _owned(db, memory_id, user, *, lock=True):
    query = select(AIMemory).where(AIMemory.id == memory_id, AIMemory.user_id == user.id)
    row = (await db.execute(query.with_for_update() if lock else query)).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "memory not found")
    return row


async def _key_taken(db, user, agent_id, key, *, except_ids=()):
    query = select(AIMemory.id).where(AIMemory.user_id == user.id, AIMemory.key == key,
                                      AIMemory.agent_id.is_(None) if agent_id is None else AIMemory.agent_id == agent_id)
    if except_ids:
        query = query.where(AIMemory.id.notin_(list(except_ids)))
    existing = (await db.execute(query)).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(409, f"A note with key {key!r} already exists in that scope (id {existing}); merge them or choose another key.")


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
    """Create, or update the note with this key in this scope (its previous state is kept)."""
    content = payload.content.strip()
    category = _checked(payload.key, content, payload.category, payload.kind, allow_reserved=reserved_prefix(payload.key))
    await _agent_exists(db, payload.agent_id)
    scope = AIMemory.agent_id.is_(None) if payload.agent_id is None else AIMemory.agent_id == payload.agent_id
    row = (await db.execute(select(AIMemory).where(AIMemory.user_id == user.id, AIMemory.key == payload.key, scope).with_for_update())).scalar_one_or_none()
    if row is None:
        db.add(AIMemory(user_id=user.id, agent_id=payload.agent_id, key=payload.key, content=content, category=category, kind=payload.kind))
    else:
        # Older clients send only key and content: keep the note's category and kind then.
        new = (content, category if "category" in payload.model_fields_set else row.category, payload.kind or row.kind)
        if new != (row.content, row.category, row.kind):
            await db.execute(snapshot(row, "update", "owner"))
            (row.content, row.category, row.kind), row.source_task_id = new, None
    await db.commit()
    return {"ok": True}


@router.patch("/ai/memory/{memory_id}")
async def edit_memory(memory_id: uuid.UUID, payload: MemoryEdit, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await _owned(db, memory_id, user)
    sent = payload.model_fields_set
    key = payload.key if "key" in sent and payload.key else row.key
    content = payload.content.strip() if "content" in sent and payload.content else row.content
    kind = payload.kind if "kind" in sent else row.kind
    category = _checked(key, content, payload.category if "category" in sent else row.category, kind,
                        allow_reserved=reserved_prefix(row.key))
    agent_id = payload.agent_id if "agent_id" in sent else row.agent_id
    await _agent_exists(db, agent_id)
    if (key, agent_id) != (row.key, row.agent_id):
        await _key_taken(db, user, agent_id, key, except_ids=[row.id])
    if (key, content, category, kind, agent_id) == (row.key, row.content, row.category, row.kind, row.agent_id):
        return memory_read(row)
    await db.execute(snapshot(row, "scope" if agent_id != row.agent_id else "update", "owner"))
    row.key, row.content, row.category, row.kind, row.agent_id = key, content, category, kind, agent_id
    row.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return memory_read(row)


@router.delete("/ai/memory/{memory_id}", status_code=204)
async def delete_memory(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await _owned(db, memory_id, user)
    await db.execute(snapshot(row, "delete", "owner"))
    await db.delete(row)
    await db.commit()


@router.post("/ai/memory/merge")
async def merge_memories(payload: MemoryMerge, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Replace several notes by one; every source note's state is kept in its history."""
    ids = list(dict.fromkeys(payload.ids))
    rows = (await db.execute(select(AIMemory).where(AIMemory.user_id == user.id, AIMemory.id.in_(ids)).with_for_update())).scalars().all()
    if len(rows) != len(ids) or len(ids) < 2:
        raise HTTPException(404, "every note to merge must exist and belong to you")
    content = payload.content.strip()
    category = _checked(payload.key, content, payload.category, payload.kind)
    await _agent_exists(db, payload.agent_id)
    await _key_taken(db, user, payload.agent_id, payload.key, except_ids=ids)
    for row in rows:
        await db.execute(snapshot(row, "merge", "owner"))
        await db.delete(row)
    await db.flush()
    merged = AIMemory(user_id=user.id, agent_id=payload.agent_id, key=payload.key, content=content, category=category, kind=payload.kind)
    db.add(merged)
    await db.commit()
    return memory_read(merged)


@router.get("/ai/memory/duplicates")
async def memory_duplicates(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(AIMemory).where(AIMemory.user_id == user.id))).scalars().all()
    return {"pairs": [{"a": a, "b": b, "score": score} for a, b, score in duplicate_pairs(rows)]}


@router.get("/ai/memory/history")
async def memory_history(memory_id: uuid.UUID | None = None, deleted: bool = False, limit: int = Query(default=50, ge=1, le=200),
                         db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Earlier states of one note, or of notes that were deleted or merged away."""
    query = select(AIMemoryVersion).where(AIMemoryVersion.user_id == user.id)
    if memory_id is not None:
        query = query.where(AIMemoryVersion.memory_id == memory_id)
    elif deleted:
        query = query.where(AIMemoryVersion.memory_id.is_(None), AIMemoryVersion.change.in_(("delete", "merge")))
    rows = (await db.execute(query.order_by(AIMemoryVersion.created_at.desc()).limit(limit))).scalars()
    return {"items": [version_read(row) for row in rows]}


@router.post("/ai/memory/history/{version_id}/restore")
async def restore_version(version_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Put a note back to an earlier state (the state it replaces is kept too)."""
    version = (await db.execute(select(AIMemoryVersion).where(AIMemoryVersion.id == version_id, AIMemoryVersion.user_id == user.id))).scalar_one_or_none()
    if version is None:
        raise HTTPException(404, "version not found")
    row = await db.get(AIMemory, version.memory_id) if version.memory_id else None
    if row is not None and row.user_id == user.id:
        if (row.agent_id, row.key) != (version.agent_id, version.key):
            await _key_taken(db, user, version.agent_id, version.key, except_ids=[row.id])
        await db.execute(snapshot(row, "restore", "owner"))
        row.key, row.agent_id, row.category, row.kind, row.content = version.key, version.agent_id, version.category, version.kind, version.content
        row.updated_at = datetime.now(timezone.utc)
    else:
        await _key_taken(db, user, version.agent_id, version.key)
        row = AIMemory(user_id=user.id, agent_id=version.agent_id, key=version.key, category=version.category, kind=version.kind, content=version.content)
        db.add(row)
    await db.commit()
    return memory_read(row)


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


class SuggestionDecision(BaseModel):
    """Optional edits when accepting; omitted fields keep the suggestion's own."""
    key: str | None = Field(default=None, min_length=1, max_length=100)
    content: str | None = Field(default=None, min_length=1, max_length=MAX_NOTE)
    category: str | None = Field(default=None, max_length=80)
    kind: Kind | None = None
    # For an update: also keep the replaced text as its own history note.
    keep_history: bool = False


def suggestion_read(row, target=None):
    return {"id": row.id, "agent_id": row.agent_id, "key": row.key, "content": row.content, "source": row.source,
            "category": row.category, "kind": row.kind, "evidence_task_id": row.evidence_task_id, "status": row.status,
            "created_at": row.created_at, "decided_at": row.decided_at, "target_memory_id": row.target_memory_id,
            "target": memory_read(target) if target is not None else None}


@router.get("/ai/memory/suggestions")
async def list_suggestions(status: Literal["pending", "accepted", "rejected"] = "pending", limit: int = Query(default=200, ge=1, le=500),
                           db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(AIMemorySuggestion, AIMemory).outerjoin(AIMemory, (AIMemory.id == AIMemorySuggestion.target_memory_id) & (AIMemory.user_id == user.id))
                             .where(AIMemorySuggestion.user_id == user.id, AIMemorySuggestion.status == status)
                             .order_by(AIMemorySuggestion.created_at.desc()).limit(limit))).all()
    return {"items": [suggestion_read(row, target) for row, target in rows]}


async def _pending(db, suggestion_id, user):
    row = (await db.execute(select(AIMemorySuggestion).where(AIMemorySuggestion.id == suggestion_id, AIMemorySuggestion.user_id == user.id)
                            .with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "suggestion not found")
    if row.status != "pending":
        raise HTTPException(409, f"suggestion already {row.status}")
    return row


async def _accept(db, row, user, payload: SuggestionDecision):
    """Save one pending suggestion as a note (or apply it to its target); the caller commits."""
    key = (payload.key or row.key).strip()
    content = (payload.content or row.content).strip()
    kind = payload.kind or row.kind
    category = _checked(key, content, payload.category if payload.category is not None else row.category, kind,
                        allow_reserved=reserved_prefix(row.key))
    target = (await db.execute(select(AIMemory).where(AIMemory.id == row.target_memory_id, AIMemory.user_id == user.id).with_for_update())
              ).scalar_one_or_none() if row.target_memory_id else None
    if target is not None:
        # An update: the note keeps its scope (and its category/kind unless new ones are given);
        # its previous text stays in the history.
        category = category if category is not None else target.category
        kind = kind or target.kind
        if key != target.key:
            await _key_taken(db, user, target.agent_id, key, except_ids=[target.id])
        await db.execute(snapshot(target, "update", "owner"))
        if payload.keep_history:
            history_key = f"{target.key[:80]}.history.{date.today().isoformat()}"
            await db.execute(insert(AIMemory).values(user_id=user.id, agent_id=target.agent_id, key=history_key, content=target.content,
                                                     category=target.category, kind="history").on_conflict_do_nothing(constraint="uq_ai_memory_user_key"))
        target.key, target.content, target.category, target.kind = key, content, category, kind
        target.source_task_id, target.updated_at = row.evidence_task_id, datetime.now(timezone.utc)
    else:
        scope = AIMemory.agent_id.is_(None) if row.agent_id is None else AIMemory.agent_id == row.agent_id
        existing = (await db.execute(select(AIMemory).where(AIMemory.user_id == user.id, AIMemory.key == key, scope).with_for_update())).scalar_one_or_none()
        if existing is not None:
            await db.execute(snapshot(existing, "update", "owner"))
            existing.content, existing.category, existing.kind, existing.updated_at = content, category, kind, datetime.now(timezone.utc)
        else:
            db.add(AIMemory(user_id=user.id, agent_id=row.agent_id, key=key, content=content, category=category, kind=kind,
                            source_task_id=row.evidence_task_id))
    row.status, row.decided_at = "accepted", datetime.now(timezone.utc)


@router.post("/ai/memory/suggestions/{suggestion_id}/accept")
async def accept_suggestion(suggestion_id: uuid.UUID, payload: SuggestionDecision | None = None,
                            db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await _pending(db, suggestion_id, user)
    await _accept(db, row, user, payload or SuggestionDecision())
    await db.commit()
    return suggestion_read(row)


class AcceptAll(BaseModel):
    # The suggestions the owner was shown; ones that arrived later are not accepted unseen.
    ids: list[uuid.UUID] = Field(min_length=1, max_length=1000)


@router.post("/ai/memory/suggestions/accept-all")
async def accept_all_suggestions(payload: AcceptAll, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """Accept the listed pending suggestions as they are, each under the same rules as a single accept.

    Each one runs in its own savepoint: one that cannot be saved (an invalid key, a key already used
    in that scope) is skipped and reported, the others are saved. Update suggestions keep the
    replaced text in the note's history, as a single accept does.
    """
    accepted, failed = 0, []
    for suggestion_id in dict.fromkeys(payload.ids):
        try:
            async with db.begin_nested():
                row = (await db.execute(select(AIMemorySuggestion).where(
                    AIMemorySuggestion.id == suggestion_id, AIMemorySuggestion.user_id == user.id,
                    AIMemorySuggestion.status == "pending").with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
                if row is None:
                    continue  # decided meanwhile, or not the owner's
                key = row.key
                await _accept(db, row, user, SuggestionDecision())
                await db.flush()
            accepted += 1
        except HTTPException as exc:
            failed.append({"id": suggestion_id, "key": key, "error": str(exc.detail)})
        except IntegrityError:
            failed.append({"id": suggestion_id, "key": key, "error": "A note with this key already exists in that scope; accept it on its own with another key."})
    await db.commit()
    return {"accepted": accepted, "failed": failed}


@router.post("/ai/memory/suggestions/{suggestion_id}/reject")
async def reject_suggestion(suggestion_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    row = await _pending(db, suggestion_id, user)
    row.status, row.decided_at = "rejected", datetime.now(timezone.utc)
    await db.commit()
    return suggestion_read(row)
