import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from worker_ai.ai.agent_state import set_agent_state
from worker_ai.ai.memory import memory_owner
from worker_ai.ai.runtime import TaskCancelled, run_agent
from worker_ai.ai.tools.exec_tools import EXECUTORS
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

    _run_agent_task(task_id, self.request.id)
    with SessionLocal() as db:
        task = db.get(AITask, task_id)
        if task is None:
            return
        text = task.response_message or (f"Ops AI could not answer: {task.error_message}" if task.error_message else "(no answer)")
    try:
        post_message(backend, room_token, text, reply_to or None)
    except Exception as exc:  # noqa: BLE001 - the answer is still in Ops Center even if Talk rejects the post
        with SessionLocal() as db:
            task = db.get(AITask, task_id)
            if task is not None:
                task.error_message = f"answered, but posting to Talk failed: {exc}"
                db.commit()


def _run_agent_task(task_id: str, celery_task_id: str | None) -> None:
    with SessionLocal() as db:
        task = db.execute(select(AITask).where(AITask.id == task_id).with_for_update()).scalar_one_or_none()
        if task is None or task.status != "queued":
            return
        agent = task.agent  # lazy-loaded relationship

        task.status = "running"
        task.celery_task_id = celery_task_id
        task.started_at = _now()
        db.commit()

        try:
            # run_agent owns every agent.status/current_task/last_activity_at
            # transition (and the matching Ops Floor event) for both this
            # top-level agent and any specialist it delegates to - see its
            # docstring and agent_state.set_agent_state.
            contextual_message = _build_contextual_message(db, task.conversation_key, task.input_message, task)
            result = run_agent(db, agent, contextual_message, task_id=str(task.id))
            db.refresh(task, with_for_update=True)
            if task.status == "cancelled":
                raise TaskCancelled()
            task.response_message = result.text
            # dict.fromkeys preserves first-seen order while deduping -
            # the Coordinator's own slug plus every delegated specialist.
            task.agents_used = list(dict.fromkeys(result.agents_used))
            task.tools_used = result.tools_used
            task.data_sources = list(dict.fromkeys(result.data_sources))
            task.status = "completed"
        except TaskCancelled:
            db.refresh(task)
            task.status = "cancelled"
        except Exception as exc:  # noqa: BLE001 - must never crash the worker silently
            # A genuinely unexpected bug, not a normal provider/tool
            # failure (those are already handled inside run_agent) - still
            # needs the agent visibly marked down rather than left mid-task.
            db.refresh(task, with_for_update=True)
            if task.status != "cancelled":
                task.status = "failed"
                task.error_message = str(exc)
                set_agent_state(db, agent, "error", str(exc), None, str(task.id))
        finally:
            task.completed_at = _now()
            if task.started_at:
                task.duration_ms = int((task.completed_at - task.started_at).total_seconds() * 1000)
            db.commit()


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
        action = db.get(AIAction, action_id)
        if action is None or action.status != "approved":
            return
        if action.task_id and db.execute(select(AITask.status).where(AITask.id == action.task_id)).scalar_one_or_none() == "cancelled":
            action.status = "expired"
            db.commit()
            return
        agent = action.agent

        set_agent_state(db, agent, "working", f"Executing: {action.action}", None, str(action.task_id) if action.task_id else None)

        try:
            executor = EXECUTORS[action.tool]
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
        )
