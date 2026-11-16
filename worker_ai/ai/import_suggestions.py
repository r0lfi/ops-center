""""Suggest facts from the import": read imported ChatGPT conversations in
batches and propose memory suggestions (source "import", keys chatgpt.*).

Started only by the owner after confirming the estimate on the Nova page.
Each batch is one model call through the shared weekly budget; a refused
budget stops the run and leaves the remaining conversations for later. A
batch's conversations are marked analyzed once its call succeeded, so a
conversation is never paid for twice. An advisory lock per owner keeps two
runs apart.
"""
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import func, select, text

from app.core.memory_rules import IMPORT_PREFIXES, content_hash
from app.models.ai import AIAgent
from app.models.ai_memory import AIImportedConversation, AIMemory
from app.services.ai_budget import AIBudgetStopped, release_unattempted, reserve, settle
from app.services.nova_import import BATCH_CHARS, MAX_CALLS_PER_RUN, OUTPUT_CAP, SUGGEST_PROMPT, _slug
from app.services.memory_suggestions import insert_new, suggestion_row
from worker_ai.ai.journal import memory_enabled, parse_output
from worker_ai.ai.providers import build_provider
from worker_ai.ai.providers.base import ProviderCallNotStarted
from worker_ai.ai.transport import call_fits, deadline

logger = logging.getLogger(__name__)
PREFIX = IMPORT_PREFIXES["chatgpt"]


def batches(conversations):
    """Group conversations into chunks of at most BATCH_CHARS characters."""
    group, size = [], 0
    for conversation in conversations:
        piece = f"### {conversation.title}\n{conversation.transcript[:BATCH_CHARS]}"
        if group and size + len(piece) > BATCH_CHARS:
            yield group
            group, size = [], 0
        group.append((conversation, piece))
        size += len(piece)
    if group:
        yield group


def suggestion_rows(owner_id, agent_id, proposals):
    rows = []
    for proposal in proposals:
        content = proposal.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        key = f"{PREFIX}{_slug(str(proposal.get('key') or content))}-{content_hash(content)[:6]}"
        row, _ = suggestion_row(owner_id, agent_id, key, content, "import", allowed_prefix=PREFIX)
        if row:
            rows.append(row)
    return rows


def run_import_suggestions(db, owner_id, calls_before: int = 0) -> dict:
    """One task of a run; summary["continue"] is set when the run goes on in a new task.

    calls_before counts the calls earlier tasks of the same run made, so the
    MAX_CALLS_PER_RUN limit the owner confirmed holds across tasks.
    """
    agent = db.execute(select(AIAgent).where(AIAgent.slug == "nova", AIAgent.personal.is_(True))).scalar_one_or_none()
    summary = {"calls": 0, "conversations": 0, "suggested": 0, "stopped": None}
    if agent is None or not agent.enabled or agent.provider is None or not memory_enabled(db, owner_id):
        summary["stopped"] = "nova unavailable or memory disabled"
        return summary
    lock = f"import-suggestions:{owner_id}"
    if not db.execute(text("SELECT pg_try_advisory_lock(hashtext(:k))"), {"k": lock}).scalar():
        summary["stopped"] = "another run is in progress"
        return summary
    try:
        provider = build_provider(agent.provider)
        model = agent.model or agent.provider.default_model
        pending = db.execute(select(AIImportedConversation).where(
            AIImportedConversation.user_id == owner_id, AIImportedConversation.analyzed_at.is_(None))
            .order_by(AIImportedConversation.started_at.nulls_last())).scalars().all()
        started = time.monotonic()
        for group in batches(pending):
            if calls_before + summary["calls"] >= MAX_CALLS_PER_RUN:
                summary["stopped"] = "call limit for one run reached; start again for the rest"
                break
            if summary["calls"] and not call_fits(started):
                summary["continue"] = calls_before + summary["calls"]
                break
            db.expire_all()
            if not memory_enabled(db, owner_id):
                summary["stopped"] = "memory disabled"
                break
            messages = [{"role": "user", "content": "\n\n".join(piece for _, piece in group)}]
            try:
                reservation = reserve(db, agent, model, SUGGEST_PROMPT, messages, [], OUTPUT_CAP, None)
            except AIBudgetStopped as exc:
                summary["stopped"] = str(exc)
                break
            try:
                with deadline():
                    result = provider.chat(system=SUGGEST_PROMPT, messages=messages, tools=[], model=model, max_tokens=OUTPUT_CAP)
            except ProviderCallNotStarted as exc:
                release_unattempted(db, reservation)
                summary["stopped"] = str(exc)
                break
            settle(db, reservation, result.input_tokens, result.output_tokens, usage_reported=result.usage_reported,
                   cache_read=result.cache_read_tokens, cache_write=result.cache_write_tokens,
                   cache_write_1h=result.cache_write_1h_tokens)
            from worker_ai.ai.runtime import _record_usage
            _record_usage(db, agent, model, result.input_tokens, result.output_tokens, None,
                          reservation_id=reservation.id if reservation is not None else None)
            _, proposals = parse_output(result.text)
            rows = [r for r in suggestion_rows(owner_id, agent.id, proposals) if not db.scalar(
                select(func.count()).select_from(AIMemory).where(AIMemory.user_id == owner_id, AIMemory.content == r["content"]))]
            summary["suggested"] += len(db.execute(insert_new(rows)).scalars().all()) if rows else 0
            now = datetime.now(timezone.utc)
            for conversation, _ in group:
                conversation.analyzed_at = now
            summary["calls"] += 1
            summary["conversations"] += len(group)
            db.commit()
        return summary
    finally:
        db.execute(text("SELECT pg_advisory_unlock(hashtext(:k))"), {"k": lock})
        db.commit()
        logger.info("nova import suggestions for %s: %s", owner_id, summary)
