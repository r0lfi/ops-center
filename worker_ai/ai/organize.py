"""Import & Organize in the AI worker: one budgeted model call per section.

The job's sections were cut by the API (app/services/memory_organize.py). Each
pending section is cleaned of credential lines, sent with an index of the most
related existing notes, and its validated proposals are stored on the section,
committing after every section so the page can show progress. A failed section
is marked failed with its reason and the others continue (it is tried again only
when the owner retries); a refused budget
stops the run and leaves the rest pending for a retry. A run stops before a call that would
not fit in the task's time limit and continues in a new task. At the end all
proposals are compared with the owner's current notes and the job becomes
done, partial or failed. Nothing is written to ai_memories here.
"""
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select, text

from app.models.ai import AIAgent
from app.models.ai_memory import AIMemory, AIMemoryOrganizeJob
from app.services.ai_budget import AIBudgetStopped, release_unattempted, reserve, settle
from app.services.memory_organize import OUTPUT_CAP, PROMPT, clean_section, compare, index_for, message_for, normalize, parse_memories, split_sections
from worker_ai.ai.journal import memory_enabled
from worker_ai.ai.memory import _not_reserved, visible_notes
from worker_ai.ai.providers import ProviderError, build_provider
from worker_ai.ai.providers.base import ProviderCallNotStarted
from worker_ai.ai.transport import call_fits, deadline

logger = logging.getLogger(__name__)


def _notes(db, owner_id, agent_id):
    return db.execute(select(AIMemory).where(*visible_notes(owner_id, agent_id), *_not_reserved())).scalars().all()


def run_organize(db, job_id) -> str:
    job = db.get(AIMemoryOrganizeJob, job_id)
    if job is None or job.input_text is None:
        return "no job"
    lock = f"organize:{job.id}"
    if not db.execute(text("SELECT pg_try_advisory_lock(hashtext(:k))"), {"k": lock}).scalar():
        return "already running"
    try:
        # A working copy: JSONB is replaced (not mutated) on every save so each change is persisted.
        sections = [dict(s) for s in job.sections]
        agent = db.get(AIAgent, job.agent_id)
        if agent is None or not agent.enabled or agent.provider is None or not memory_enabled(db, job.user_id):
            for section in sections:
                if section.get("status") != "done":
                    section.update(status="failed", error="Nova is unavailable or long-term memory is off.")
            job.sections, job.status, job.finished_at = sections, "failed", datetime.now(timezone.utc)
            db.commit()
            return "failed"
        job.status = "running"
        db.commit()
        provider, model = build_provider(agent.provider), agent.model or agent.provider.default_model
        texts = split_sections(job.input_text)
        notes = _notes(db, job.user_id, agent.id)
        started, more, attempted = time.monotonic(), False, 0
        for section in sections:
            # One attempt per section and run: a failed section waits for the owner's retry, and every
            # task attempts at least one pending section, so the run always ends.
            if section.get("status") != "pending":
                continue
            if attempted and not call_fits(started):
                more = True  # the rest continues in a new task (worker_ai.tasks.organize_memory)
                break
            attempted += 1
            cleaned, secrets = clean_section(texts[section["index"]])
            section["secrets"] = secrets
            messages = [{"role": "user", "content": message_for(cleaned, index_for(cleaned, notes, agent.id))}]
            try:
                reservation = reserve(db, agent, model, PROMPT, messages, [], OUTPUT_CAP, None)
            except AIBudgetStopped as exc:
                section.update(status="pending", error=str(exc))
                break
            try:
                try:
                    with deadline():
                        result = provider.chat(system=PROMPT, messages=messages, tools=[], model=model, max_tokens=OUTPUT_CAP)
                except ProviderCallNotStarted:
                    release_unattempted(db, reservation)
                    raise
                settle(db, reservation, result.input_tokens, result.output_tokens, usage_reported=result.usage_reported,
                       cache_read=result.cache_read_tokens, cache_write=result.cache_write_tokens,
                       cache_write_1h=result.cache_write_1h_tokens)
                from worker_ai.ai.runtime import _record_usage
                _record_usage(db, agent, model, result.input_tokens, result.output_tokens, None,
                              reservation_id=reservation.id if reservation is not None else None)
                items = parse_memories(result.text)
                if items is None:
                    raise ValueError("The model's reply for this section could not be read; retry it.")
                proposals, dropped = [], 0
                for item in items:
                    proposal, problem = normalize(item, section["index"])
                    if proposal:
                        proposals.append(proposal)
                    else:
                        dropped += 1
                section.update(status="done", error=None, proposals=proposals, dropped=dropped)
            except (ProviderError, ProviderCallNotStarted, ValueError) as exc:
                section.update(status="failed", error=str(exc)[:300])
            job.sections = [dict(s) for s in sections]
            db.commit()
        if more:
            job.sections = [dict(s) for s in sections]
            db.commit()
            return "continue"
        done = [s for s in sections if s.get("status") == "done"]
        job.proposals = compare([p for s in done for p in s.get("proposals", [])], _notes(db, job.user_id, agent.id), agent.id)
        job.status = "done" if len(done) == len(sections) else "partial" if done else "failed"
        job.finished_at = datetime.now(timezone.utc)
        db.commit()
        logger.info("memory organize %s: %s, %d proposals", job.id, job.status, len(job.proposals))
        return job.status
    finally:
        db.execute(text("SELECT pg_advisory_unlock(hashtext(:k))"), {"k": lock})
        db.commit()
