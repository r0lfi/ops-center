"""Owner-only imports into nova's memory (see app/services/nova_import.py)."""
import asyncio
import math
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.core.ai_pricing import UnknownPrice, rates, token_cost
from app.core.config import get_settings
from app.core.memory_rules import IMPORT_PREFIXES
from app.db.session import get_db
from app.models.ai import AIAgent
from app.models.ai_memory import AIImportedConversation, AIMemory, AIMemoryPreference, AIMemorySuggestion
from app.models.user import User
from app.services.celery_client import get_celery_client
from app.services.nova_import import (BATCH_CHARS, OUTPUT_CAP, PROMPT_TOKENS, ImportRejected, conversation_rows,
                                        memory_list_rows, parse_memory_list, read_export)
from app.services.memory_suggestions import insert_new

router = APIRouter()
MAX_LIST_BYTES = 2 * 1024 * 1024
# A parsed export can take several times its JSON size in memory: parse one at
# a time per API process and turn away concurrent uploads instead of queueing them.
_EXPORT_PARSE = asyncio.Semaphore(1)
Source = Literal["chatgpt", "claude", "gemini", "other"]
Kind = Literal["memory_list", "chatgpt_export"]


async def _nova(db) -> AIAgent:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "nova", AIAgent.personal.is_(True)))).scalar_one_or_none()
    if agent is None:
        raise HTTPException(404, "nova is not installed")
    return agent


async def _memory_enabled(db, user) -> bool:
    preference = await db.get(AIMemoryPreference, user.id)
    return preference is None or preference.enabled


def _size(upload: UploadFile) -> int:
    upload.file.seek(0, 2)
    size = upload.file.tell()
    upload.file.seek(0)
    return size


async def _parse(upload: UploadFile, kind: Kind, source: Source, user, agent):
    settings = get_settings()
    size = _size(upload)
    if size > settings.nova_import_max_mb * 1024 * 1024:
        raise HTTPException(413, f"The file is larger than the {settings.nova_import_max_mb} MB limit.")
    try:
        if kind == "memory_list":
            if size > MAX_LIST_BYTES:
                raise HTTPException(413, "A memory list is limited to 2 MB of text.")
            text = (await upload.read()).decode("utf-8", errors="replace")
            parsed = parse_memory_list(text)
            return {"kind": kind, **parsed, "rows": memory_list_rows(user.id, agent.id, source, parsed["items"])}
        if source != "chatgpt":
            raise HTTPException(422, "Data exports are supported from ChatGPT only.")
        if _EXPORT_PARSE.locked():
            raise HTTPException(429, "Another export is being read; try again in a minute.")
        async with _EXPORT_PARSE:
            export = await run_in_threadpool(read_export, upload.file, max_json_bytes=settings.nova_import_max_json_mb * 1024 * 1024,
                                             max_ratio=settings.nova_import_max_ratio)
            parsed = await run_in_threadpool(conversation_rows, user.id, agent.id, export["conversations"])
            del export
        return {"kind": kind, "has_user_json": export["has_user_json"], "ignored_files": export["ignored_files"], **parsed}
    except ImportRejected as exc:
        raise HTTPException(422, str(exc)) from exc


async def _compare(db, user, parsed) -> dict:
    """Counts against what is already stored; the summary a preview shows."""
    rows = parsed["rows"]
    if parsed["kind"] == "memory_list":
        hashes = [r["content_hash"] for r in rows]
        known = set((await db.execute(select(AIMemorySuggestion.content_hash).where(
            AIMemorySuggestion.user_id == user.id, AIMemorySuggestion.content_hash.in_(hashes)))).scalars()) if hashes else set()
        fresh = [r for r in rows if r["content_hash"] not in known]
        return {"kind": "memory_list", "items": len(parsed["items"]), "new_suggestions": len(fresh), "already_suggested": len(rows) - len(fresh),
                "filtered_secrets": parsed["filtered_secrets"], "duplicates": parsed["duplicates"], "skipped_short": parsed["skipped_short"],
                "sample": [r["content"][:200] for r in fresh[:5]]}
    existing = dict((await db.execute(select(AIImportedConversation.external_id, AIImportedConversation.content_hash).where(
        AIImportedConversation.user_id == user.id, AIImportedConversation.source == "chatgpt"))).all())
    new = [r for r in rows if r["external_id"] not in existing]
    changed = [r for r in rows if r["external_id"] in existing and existing[r["external_id"]] != r["content_hash"]]
    return {"kind": "chatgpt_export", "conversations": len(rows), "new": len(new), "updated": len(changed),
            "unchanged": len(rows) - len(new) - len(changed), "filtered_secret_lines": parsed["filtered_secret_lines"],
            "skipped_empty": parsed["skipped_empty"], "ignored_files": parsed["ignored_files"], "user_json_stored": False,
            "sample": [r["title"][:120] for r in (new + changed)[:5]]}


@router.get("/ai/imports")
async def import_status(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _nova(db)
    total, analyzed = (await db.execute(select(func.count(), func.count(AIImportedConversation.analyzed_at)).where(
        AIImportedConversation.user_id == user.id))).one()
    pending = await db.scalar(select(func.count()).select_from(AIMemorySuggestion).where(
        AIMemorySuggestion.user_id == user.id, AIMemorySuggestion.source == "import", AIMemorySuggestion.status == "pending"))
    return {"memory_enabled": await _memory_enabled(db, user), "conversations": total, "analyzed": analyzed,
            "pending_import_suggestions": pending, "max_upload_mb": get_settings().nova_import_max_mb}


@router.post("/ai/imports/preview")
async def preview_import(kind: Kind = Form(...), source: Source = Form("chatgpt"), file: UploadFile = File(...),
                         db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    return await _compare(db, user, await _parse(file, kind, source, user, agent))


@router.post("/ai/imports")
async def apply_import(kind: Kind = Form(...), source: Source = Form("chatgpt"), file: UploadFile = File(...),
                       db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    if not await _memory_enabled(db, user):
        raise HTTPException(409, "Turn on long-term memory before importing.")
    parsed = await _parse(file, kind, source, user, agent)
    summary = await _compare(db, user, parsed)
    rows = parsed["rows"]
    if kind == "memory_list":
        for start in range(0, len(rows), 500):
            await db.execute(insert_new(rows[start:start + 500]))
    else:
        table = AIImportedConversation.__table__
        for start in range(0, len(rows), 200):
            statement = insert(table).values(rows[start:start + 200])
            await db.execute(statement.on_conflict_do_update(
                constraint="uq_ai_imported_conversation",
                set_={"title": statement.excluded.title, "started_at": statement.excluded.started_at,
                      "transcript": statement.excluded.transcript, "content_hash": statement.excluded.content_hash,
                      "updated_at": func.now(), "analyzed_at": None},
                where=table.c.content_hash != statement.excluded.content_hash))
    await db.commit()
    return {"imported": True, **summary}


async def _estimate(db, user, agent) -> dict:
    count, chars = (await db.execute(select(func.count(), func.coalesce(func.sum(func.least(func.length(AIImportedConversation.transcript), BATCH_CHARS)), 0))
                                     .where(AIImportedConversation.user_id == user.id, AIImportedConversation.analyzed_at.is_(None)))).one()
    calls = math.ceil(chars / BATCH_CHARS) if count else 0
    input_tokens, output_tokens = math.ceil(chars / 3.5) + calls * PROMPT_TOKENS, calls * OUTPUT_CAP
    provider = agent.provider
    estimate = {"conversations": count, "model_calls": calls, "input_tokens": input_tokens, "output_tokens": output_tokens,
                "provider": provider.display_name if provider else None, "local": bool(provider and provider.kind in ("ollama", "openai_compatible")),
                "cost_usd": None, "note": None}
    if provider is None:
        estimate["note"] = "Nova has no provider."
        return estimate
    try:
        estimate["cost_usd"] = float(token_cost(input_tokens, output_tokens, *rates(provider.kind, agent.model or provider.default_model, provider.base_url)))
    except UnknownPrice as exc:
        estimate["note"] = str(exc)
    return estimate


@router.get("/ai/imports/suggest-estimate")
async def suggest_estimate(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    await db.refresh(agent, ["provider"])
    return await _estimate(db, user, agent)


class SuggestRequest(BaseModel):
    confirm: bool


@router.post("/ai/imports/suggest")
async def suggest_from_imports(payload: SuggestRequest, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    agent = await _nova(db)
    await db.refresh(agent, ["provider"])
    if not payload.confirm:
        raise HTTPException(422, "Confirm the estimate first.")
    if not await _memory_enabled(db, user):
        raise HTTPException(409, "Turn on long-term memory first.")
    if not agent.enabled or agent.provider is None or not agent.provider.enabled:
        raise HTTPException(409, "Nova is disabled or has no enabled provider.")
    estimate = await _estimate(db, user, agent)
    if not estimate["conversations"]:
        raise HTTPException(409, "No imported conversations are waiting to be analyzed.")
    get_celery_client().send_task("worker_ai.tasks.nova_import_suggestions", args=[str(user.id)], queue="ai")
    return {"queued": True, **estimate}


@router.delete("/ai/imports/{source}")
async def delete_imports(source: Source, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await _nova(db)
    prefix = IMPORT_PREFIXES[source]
    conversations = (await db.execute(delete(AIImportedConversation).where(
        AIImportedConversation.user_id == user.id, AIImportedConversation.source == source))).rowcount
    suggestions = (await db.execute(delete(AIMemorySuggestion).where(
        AIMemorySuggestion.user_id == user.id, AIMemorySuggestion.key.startswith(prefix, autoescape=True)))).rowcount
    notes = (await db.execute(delete(AIMemory).where(
        AIMemory.user_id == user.id, AIMemory.key.startswith(prefix, autoescape=True)))).rowcount
    await db.commit()
    return {"deleted_conversations": conversations, "deleted_suggestions": suggestions, "deleted_notes": notes}
