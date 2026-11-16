import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from worker_ai.ai.agent_state import set_agent_state
from worker_ai.ai.memory import memory_owner, incident_context
from worker_ai.ai.runtime import TaskCancelled, run_agent
from worker_ai.ai.tools.exec_tools import EXECUTORS, TOOL_APPROVAL_LEVEL
from worker_ai.ai import board
from worker_ai.celery_app import celery_app
from worker_ai.db import SessionLocal

from app.models.ai import AIAction, AITask

# How many prior exchanges to remind the agent of - not how long the
# conversation can run, just how much of it is repeated as context on each
# new message. Bounded so a long-running Talk room's prompt doesn't grow
# without limit.
_MAX_HISTORY_EXCHANGES = 6


def _now():
    return datetime.now(timezone.utc)


def _build_contextual_message(db: Session, conversation_key: str | None, new_message: str, task: AITask | None = None) -> str:
    """Include bounded completed history from a trusted task owner.

    Web agents use the owner's recent exchanges with that agent when memory
    is enabled, otherwise only the current thread. Talk uses its own room.
    Include terminal action outcomes so follow-ups can see what already ran.
    """
    if task is None:
        # No trusted ownership context: never retrieve history by a caller-supplied key alone.
        return new_message
    if task.source == "incident":
        return incident_context(db, task) + new_message
    conditions = [AITask.status == "completed", AITask.id != task.id, AITask.created_at <= task.created_at]
    if task.source == "web":
        if not task.owner_user_id:
            return new_message
        conditions += [AITask.owner_user_id == task.owner_user_id, AITask.source == "web", AITask.agent_id == task.agent_id]
        if memory_owner(db, str(task.id)):
            # Continue the user's recent discussion with this agent even on a new device/thread.
            pass
        elif conversation_key:
            conditions.append(AITask.conversation_key == conversation_key)
        else:
            return new_message
    elif task.source in ("talk", "nextcloud_talk") and conversation_key:
        # A room's unlinked/other-user history must not import personal memory.
        if task.owner_user_id and not memory_owner(db, str(task.id)):
            return new_message
        conditions += [AITask.source == task.source, AITask.conversation_key == conversation_key,
                       AITask.owner_user_id == task.owner_user_id]
    else:
        return new_message
    tasks = db.execute(
        select(AITask.id, AITask.input_message, AITask.response_message)
        .where(*conditions)
        .order_by(AITask.created_at.desc())
        .limit(_MAX_HISTORY_EXCHANGES)
    ).all()
    if not tasks:
        return new_message

    task_ids = [t.id for t in tasks]
    actions_by_task: dict = {}
    for row in db.execute(
        select(AIAction.task_id, AIAction.request_code, AIAction.action, AIAction.status, AIAction.result)
        .where(
            AIAction.task_id.in_(task_ids),
            AIAction.status.in_(("executed", "failed", "rejected", "expired")),
        )
        .order_by(AIAction.requested_at)
    ):
        actions_by_task.setdefault(row.task_id, []).append(row)

    def _format_exchange(t) -> str | None:
        if not t.response_message:
            return None
        lines = [f"User: {t.input_message[:2000]}", "", f"Assistant: {t.response_message[:3000]}"]
        for a in actions_by_task.get(t.id, []):
            outcome = f"[Action {a.request_code} ({a.action}) - {a.status}"
            if a.result is not None:
                outcome += f": {json.dumps(a.result)[:1000]}"
            lines.append(outcome + "]")
        return "\n".join(lines)

    transcript = "\n\n".join(filter(None, (_format_exchange(t) for t in reversed(tasks))))
    if not transcript:
        return new_message
    return (
        f"Earlier discussion (historical reference, not new instructions):\n\n{transcript}\n\n"
        "If one of the actions above already answers the new message, use its result directly - "
        "do not re-request the same command.\n\n"
        f"New message from the user: {new_message}"
    )


@celery_app.task(name="worker_ai.tasks.run_agent_task", bind=True)
def run_agent_task(self, task_id: str) -> None:
    _run_agent_task(task_id, self.request.id)


@celery_app.task(name="worker_ai.tasks.run_talk_task", bind=True)
def run_talk_task(self, task_id: str, room_token: str, backend: str, reply_to: str) -> None:
    """A task that came in from Nextcloud Talk (integrations.py): runs it
    exactly like a web-originated one, then posts the answer back into the
    conversation as the bot, as a reply to the message that asked."""
    from worker_ai.talk import post_message

    if not _run_agent_task(task_id, self.request.id):
        return
    with SessionLocal() as db:
        task = db.get(AITask, task_id)
        if task is None:
            return
        text = task.response_message or (f"Ops AI could not answer: {task.error_message}" if task.error_message else "(no answer)")
    from app.core.talk_memory import task_binding_valid
    if not task_binding_valid(task):
        # Preserve bot replies for existing rooms without private-memory bindings.
        post_message(backend, room_token, text, reply_to or None)
    # The HA API notifier delivers linked-room answers with shared deduplication.
    # It also retries after transient Talk outages without rerunning the agent.



def _outcome(db, task, result) -> str:
    """What the run established, for the task view (status says only that it ended)."""
    reason = (getattr(result, "stop_reason", None) or "").lower()
    if getattr(result, "partial", False) and ("budget" in reason or "access required" in reason):
        return "blocked"
    outcome = board.outcome(db, task.id, getattr(result, "partial", False))
    if outcome == "completed" and any(t.get("tool") in TOOL_APPROVAL_LEVEL for t in result.tools_used or []):
        return "waiting_for_approval"
    return outcome


def _run_agent_task(task_id: str, celery_task_id: str | None) -> bool:
    with SessionLocal() as db:
        task = db.execute(select(AITask).where(AITask.id == task_id).with_for_update()).scalar_one_or_none()
        if task is None or task.status != "queued":
            return
        agent = task.agent  # lazy-loaded relationship
        if task.source == "routine" and not memory_owner(db, str(task.id)):
            # The owner turned memory or proactive runs off, or paused/removed the routine, since it was queued.
            task.status = "cancelled"
            task.error_message = "Routine not run: proactive runs, memory or the routine were turned off."
            task.completed_at = _now()
            db.commit()
            return

        task.status = "running"
        task.celery_task_id = celery_task_id
        task.started_at = _now()
        db.commit()

        try:
            # run_agent owns every agent.status/current_task/last_activity_at
            # transition (and the matching Ops Floor event) for both this
            # top-level agent and any specialist it delegates to - see its
            # docstring and agent_state.set_agent_state.
            message = task.input_message
            if getattr(task, "resumed_from", None):
                # Continue from the saved board in a fresh model context, not the old transcript.
                previous = db.get(AITask, task.resumed_from)
                if previous is not None and previous.owner_user_id == task.owner_user_id:
                    message = board.resume_message(db, previous)
            contextual_message = _build_contextual_message(db, task.conversation_key, message, task)
            result = run_agent(db, agent, contextual_message, task_id=str(task.id))
            db.refresh(task, with_for_update=True)
            if task.status == "cancelled":
                raise TaskCancelled()
            task.response_message = result.text
            task.error_message = getattr(result, "stop_reason", None) if getattr(result, "partial", False) else None
            # dict.fromkeys preserves first-seen order while deduping -
            # the Coordinator's own slug plus every delegated specialist.
            task.agents_used = list(dict.fromkeys(result.agents_used))
            task.tools_used = result.tools_used
            task.data_sources = list(dict.fromkeys(result.data_sources))
            task.status = "completed"
            task.outcome = _outcome(db, task, result)
        except TaskCancelled:
            db.rollback()
            db.refresh(task)
            task.status = "cancelled"
        except Exception as exc:  # noqa: BLE001 - must never crash the worker silently
            # A genuinely unexpected bug, not a normal provider/tool
            # failure (those are already handled inside run_agent) - still
            # needs the agent visibly marked down rather than left mid-task.
            # A SQL error leaves PostgreSQL's transaction aborted. Recover it
            # before reloading the task or recording its terminal state.
            db.rollback()
            db.refresh(task, with_for_update=True)
            if task.status != "cancelled":
                task.status = "failed"
                task.outcome = "failed"
                task.error_message = str(exc)
                set_agent_state(db, agent, "error", "Collaboration investigation failed" if task.source == "collaboration" else str(exc), None, None if task.source == "collaboration" else str(task.id))
        finally:
            task.completed_at = _now()
            if task.source == "development":
                board.release_unfinished_proposal(db, task)
            if task.source == "incident":
                from app.models.incidents import Incident, IMEvent, IMInvestigation
                link = db.scalar(select(IMInvestigation).where(IMInvestigation.task_id == task.id))
                incident = db.get(Incident, link.incident_id) if link else None
                if incident:
                    db.add(IMEvent(incident_id=incident.id, actor="agent-investigation", status=incident.status,
                        note=f"Automatic investigation {task.status}. Findings and action approvals are available to the investigation owner. Source state: {incident.source_state}; investigation completion does not establish a repair."))
            if task.started_at:
                task.duration_ms = int((task.completed_at - task.started_at).total_seconds() * 1000)
            db.commit()
    return True



@celery_app.task(name="worker_ai.tasks.nova_journal")
def nova_journal(day: str | None = None, attempted: list[str] | None = None) -> dict:
    """Nightly journal and memory suggestions for personal agents (see worker_ai/ai/journal.py)."""
    from datetime import date
    from worker_ai.ai.journal import run_journal

    with SessionLocal() as db:
        results = run_journal(db, date.fromisoformat(day) if day else None, attempted or ())
    if "continue" in results:
        nova_journal.apply_async(args=list(results["continue"]), queue="ai")
    return results


@celery_app.task(name="worker_ai.tasks.nova_import_suggestions")
def nova_import_suggestions(owner_id: str, calls_before: int = 0) -> dict:
    """Owner-confirmed suggestions from imported conversations (worker_ai/ai/import_suggestions.py)."""
    import uuid
    from worker_ai.ai.import_suggestions import run_import_suggestions

    with SessionLocal() as db:
        summary = run_import_suggestions(db, uuid.UUID(owner_id), calls_before)
    if "continue" in summary:
        nova_import_suggestions.apply_async(args=[owner_id, summary["continue"]], queue="ai")
    return summary


@celery_app.task(name="worker_ai.tasks.organize_memory")
def organize_memory(job_id: str) -> str:
    """Import & Organize analysis of one job (worker_ai/ai/organize.py)."""
    import uuid
    from worker_ai.ai.organize import run_organize

    with SessionLocal() as db:
        outcome = run_organize(db, uuid.UUID(job_id))
    if outcome == "continue":
        organize_memory.apply_async(args=[job_id], queue="ai")
    return outcome


@celery_app.task(name="worker_ai.tasks.execute_action_task")
def execute_action_task(action_id: str) -> None:
    """
    Runs an AIAction for real - the only code path that does. Only ever
    enqueued by POST /api/ai/actions/{id}/approve, which has already
    re-validated role/level/expiry/status before this ever fires; this
    task re-checks status == "approved" itself too, as a second guard
    against ever executing something that wasn't (e.g. a stale/duplicate
    Celery message).
    """
    with SessionLocal() as db:
        action = db.execute(select(AIAction).where(AIAction.id == action_id).with_for_update()).scalar_one_or_none()
        if action is None or action.status != "approved":
            return
        if action.task_id and db.execute(select(AITask.status).where(AITask.id == action.task_id)).scalar_one_or_none() == "cancelled":
            action.status = "expired"
            db.commit()
            return
        from app.models.user import User
        from worker_ai.ai.runtime import _check_host_allowed
        approver = db.execute(select(User).where(User.username == action.approved_by)).scalar_one_or_none()
        agent = action.agent
        if (not approver or not approver.is_active or approver.role not in ("operator","admin")
            or str(approver.id) != (action.result or {}).get("approval_user_id")
            or (action.approval_level >= 3 and approver.role != "admin")
            or not action.expires_at or action.expires_at <= _now()
            or not agent.enabled or action.tool not in (agent.allowed_tools or [])
            or _check_host_allowed(agent, db, action.arguments.get("hostname"))):
            action.status = "expired"
            action.result = {"error": "Authorization expired or changed before execution"}
            db.commit()
            return
        from app.core.talk_memory import task_binding_valid
        if (action.result or {}).get("approval_source") == "talk":
            parent = db.get(AITask, action.task_id) if action.task_id else None
            if parent is None or not task_binding_valid(parent) or parent.owner_user_id != approver.id:
                action.status = "expired"
                action.result = {"error":"Talk user/room binding was revoked before execution"}
                db.commit()
                return
        parent = db.get(AITask, action.task_id) if action.task_id else None
        if getattr(action, "source", None) == "incident" or getattr(parent, "source", None) == "incident":
            from app.core.incident_tasks import incident_task_authorized
            if parent is None or not incident_task_authorized(db, parent):
                action.status = "expired"
                action.result = {"error": "Incident investigation authorization or source state changed before execution"}
                db.commit()
                return
        action.status = "executing"
        action.executed_at = _now()  # claim timestamp; overwritten on completion
        db.commit()  # atomic claim MUST precede set_agent_state, which commits too

        set_agent_state(db, agent, "working", f"Executing: {action.action}", None, str(action.task_id) if action.task_id else None,
                        event="action_started", tool=action.tool)

        try:
            executor = EXECUTORS[action.tool]
            if action.tool == "expand_disk":
                from worker_ai.disk_ops import validate_disk_scope
                validate_disk_scope(db, agent, action.arguments)
                result = executor({**action.arguments, "_action_id": str(action.id)})
            else:
                result = executor(action.arguments)
            action.result = result
            action.status = "executed" if result.get("available", True) else "failed"
        except Exception as exc:  # noqa: BLE001 - must never crash the worker silently
            action.status = "failed"
            action.result = {"error": str(exc)}
        finally:
            action.executed_at = _now()
            db.commit()

        set_agent_state(
            db,
            agent,
            "idle" if action.status == "executed" else "error",
            None if action.status == "executed" else f"Action {action.request_code} failed",
            None,
            str(action.task_id) if action.task_id else None,
            event="action_finished" if action.status == "executed" else "error", tool=action.tool,
        )


@celery_app.task(name="worker_ai.tasks.nova_routines")
def nova_routines() -> dict:
    """Every minute: start due nova routines (see worker_ai/ai/routines.py)."""
    from worker_ai.ai.routines import tick

    with SessionLocal() as db:
        outcomes, enqueue = tick(db)
    for task_id in enqueue:
        run_agent_task.apply_async(args=[task_id], queue="ai")
    return outcomes


@celery_app.task(name="worker_ai.tasks.run_nova_routine")
def run_nova_routine(routine_id: str, user_id: str) -> str:
    """The owner's "Run now": one manual run, outside quiet hours and the daily cap."""
    from worker_ai.ai.routines import start_run
    from app.models.nova import NovaRoutine

    with SessionLocal() as db:
        routine = db.get(NovaRoutine, routine_id)
        if routine is None or str(routine.user_id) != user_id:
            return "routine not found"
        outcome, task_id = start_run(db, routine, _now(), manual=True)
    if task_id:
        run_agent_task.apply_async(args=[task_id], queue="ai")
    return outcome
