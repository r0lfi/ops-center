"""Proactive nova: start due routines as owned, read-only agent tasks.

Every minute the beat entry `nova-routines` calls tick(). For each enabled
routine of an owner with proactive runs on, the latest scheduled time (within
CATCH_UP) is claimed by inserting its (routine, due_at) run row; only the
inserter continues, so two schedulers or a redelivered tick start it once.
Owner checks, quiet hours and the daily cap are decided under a per-owner
advisory lock and recorded on the run (status skipped + reason) when they
stop it. A started run creates an AITask with source="routine", which the
runtime restricts to ROUTINE_TOOLS and recall_memory (no dispatch_to_agent);
memory_owner rechecks the routine and settings when the task runs. Delivery:
the task is shown on the nova page, and a Talk routine is posted to the
owner's routed room by the API's Talk notifier (app/services/talk_watch.py).
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert

from app.core.nova_routines import CATCH_UP, in_quiet_hours, latest_due, local_day_start, local_tz, schedule_problem
from app.models.ai import AIAgent, AITask
from app.models.ai_memory import AIMemoryPreference
from app.models.nova import NovaProactiveSettings, NovaRoutine, NovaRoutineRun
from app.models.user import User

logger = logging.getLogger(__name__)
# A queued routine task older than this (and younger than REQUEUE_UNTIL) is sent to the
# queue again: its first enqueue may have been lost. _run_agent_task ignores duplicates.
REQUEUE_AFTER = timedelta(minutes=3)
REQUEUE_UNTIL = timedelta(minutes=4)


def _now():
    return datetime.now(timezone.utc)


def owner_problem(db, routine) -> str | None:
    """Why this routine may not run for its owner now, or None."""
    user = db.get(User, routine.user_id)
    if user is None or not user.is_active:
        return "owner inactive"
    preference = db.get(AIMemoryPreference, routine.user_id)
    if preference is not None and not preference.enabled:
        return "memory is off"
    settings = db.get(NovaProactiveSettings, routine.user_id)
    if settings is None or not settings.enabled:
        return "proactive runs are off"
    agent = db.get(AIAgent, routine.agent_id)
    if agent is None or not agent.personal or not agent.enabled or agent.runtime != "native" or agent.provider_id is None:
        return "nova is unavailable"
    return None


def _scheduled_today(db, owner_id, now) -> int:
    return db.scalar(select(func.count()).select_from(NovaRoutineRun).where(
        NovaRoutineRun.user_id == owner_id, NovaRoutineRun.status == "started", NovaRoutineRun.manual.is_(False),
        NovaRoutineRun.created_at >= local_day_start(now)))


def _input_message(routine, due_at) -> str:
    when = due_at.astimezone(local_tz()).strftime("%A %Y-%m-%d %H:%M %Z")
    return f"Routine \"{routine.name}\" ({when}):\n{routine.instruction}"


def start_run(db, routine, due_at, *, manual=False, now=None) -> tuple[str, str | None]:
    """Claim and start one due time of `routine`; returns (outcome, task id to enqueue)."""
    now = now or _now()
    # Serializes one owner's routines, so the daily cap holds when two fall due at once.
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"nova-routines:{routine.user_id}"})
    reason = owner_problem(db, routine)
    if reason is None and not manual:
        settings = db.get(NovaProactiveSettings, routine.user_id)
        if not routine.enabled:
            reason = "routine paused"
        elif in_quiet_hours(due_at, settings.quiet_start, settings.quiet_end):
            reason = "quiet hours"
        elif _scheduled_today(db, routine.user_id, now) >= settings.max_per_day:
            reason = "daily limit reached"
    claimed = db.execute(insert(NovaRoutineRun).values(
        routine_id=routine.id, user_id=routine.user_id, due_at=due_at, manual=manual, channel=routine.channel,
        status="skipped" if reason else "started", reason=reason,
    ).on_conflict_do_nothing(constraint="uq_nova_routine_runs_due").returning(NovaRoutineRun.id)).scalar()
    if claimed is None:
        db.rollback()
        return "already claimed", None
    if reason:
        db.commit()
        return f"skipped: {reason}", None
    user = db.get(User, routine.user_id)
    task = AITask(agent_id=routine.agent_id, requested_by=user.username, owner_user_id=routine.user_id, source="routine",
                  conversation_key=f"routine:{routine.id}", input_message=_input_message(routine, due_at), status="queued")
    db.add(task)
    db.flush()
    db.get(NovaRoutineRun, claimed).task_id = task.id
    routine.last_run_at = now
    db.commit()
    return "started", str(task.id)


def tick(db, now=None) -> tuple[dict, list[str]]:
    """Start every routine that fell due within CATCH_UP; returns (outcomes, task ids to enqueue)."""
    now = now or _now()
    outcomes, enqueue = {}, []
    routines = db.execute(select(NovaRoutine).join(
        NovaProactiveSettings, NovaProactiveSettings.user_id == NovaRoutine.user_id).where(
        NovaRoutine.enabled.is_(True), NovaProactiveSettings.enabled.is_(True))).scalars().all()
    for routine in routines:
        if schedule_problem(routine.schedule):
            continue
        due_at = latest_due(routine.schedule, now)
        if due_at < now - CATCH_UP or (routine.created_at and due_at < routine.created_at):
            continue
        if db.scalar(select(NovaRoutineRun.id).where(NovaRoutineRun.routine_id == routine.id, NovaRoutineRun.due_at == due_at)):
            continue
        try:
            outcome, task_id = start_run(db, routine, due_at, now=now)
        except Exception:  # noqa: BLE001 - one broken routine must not stop the others
            db.rollback()
            logger.exception("nova routine %s failed to start", routine.id)
            outcome, task_id = "error", None
        outcomes[str(routine.id)] = outcome
        if task_id:
            enqueue.append(task_id)
        logger.info("nova routine %s due %s: %s", routine.id, due_at.isoformat(), outcome)
    stale = db.execute(select(AITask.id).where(
        AITask.source == "routine", AITask.status == "queued",
        AITask.created_at < now - REQUEUE_AFTER, AITask.created_at >= now - REQUEUE_UNTIL)).scalars().all()
    enqueue += [str(task_id) for task_id in stale]
    return outcomes, enqueue
