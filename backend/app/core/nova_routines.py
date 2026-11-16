"""Rules for nova's proactive routines, shared by the API and the AI worker.

A routine is a five-field cron in the deployment's timezone (settings.tz), an
instruction and a channel. It runs only while the owner is active, has memory
on and has turned proactive runs on; quiet hours and a daily cap apply to
scheduled runs (a manual "Run now" is the owner asking, so it skips both).
"""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from croniter import croniter
from sqlalchemy import select

from app.core.config import get_settings
from app.core.memory_rules import SECRET_RE
from app.models.nova import NovaProactiveSettings, NovaRoutine, NovaRoutineRun

MAX_NAME = 100
MAX_INSTRUCTION = 2000
MAX_ROUTINES = 20
MAX_PER_DAY = 20
# Routines are for briefs and summaries, not polling: at least this long between runs.
MIN_INTERVAL = timedelta(minutes=30)
# A due time missed by more than this (scheduler down, worker busy) is not caught up later.
CATCH_UP = timedelta(minutes=15)


def local_tz() -> ZoneInfo:
    return ZoneInfo(get_settings().tz)


def schedule_problem(schedule) -> str | None:
    if not isinstance(schedule, str) or len(schedule.split()) != 5 or not croniter.is_valid(schedule):
        return "Use a five-field cron schedule such as '0 7 * * *' (minute hour day month weekday)."
    times = croniter(schedule, datetime(2026, 1, 5, tzinfo=timezone.utc))
    runs = [times.get_next(datetime) for _ in range(8)]
    if any(b - a < MIN_INTERVAL for a, b in zip(runs, runs[1:])):
        return f"Routines run at most every {int(MIN_INTERVAL.total_seconds() // 60)} minutes."
    return None


def routine_problem(name, schedule, instruction) -> str | None:
    """Why a routine may not be stored, or None."""
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= MAX_NAME:
        return f"Give the routine a name of at most {MAX_NAME} characters."
    if not isinstance(instruction, str) or not 1 <= len(instruction.strip()) <= MAX_INSTRUCTION:
        return f"Write an instruction of at most {MAX_INSTRUCTION} characters."
    if SECRET_RE.search(name) or SECRET_RE.search(instruction):
        return "Routines cannot contain credentials such as passwords, tokens or private keys."
    return schedule_problem(schedule)


def latest_due(schedule: str, now: datetime) -> datetime:
    """The most recent scheduled time at or before `now`, in UTC."""
    local = now.astimezone(local_tz()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    return croniter(schedule, local).get_prev(datetime).astimezone(timezone.utc)


def next_due(schedule: str, now: datetime) -> datetime:
    return croniter(schedule, now.astimezone(local_tz())).get_next(datetime).astimezone(timezone.utc)


def in_quiet_hours(moment: datetime, start: time, end: time) -> bool:
    """Whether `moment` falls in [start, end) local time; the window may span midnight."""
    local = moment.astimezone(local_tz()).time()
    if start == end:
        return False
    return start <= local < end if start < end else local >= start or local < end


def local_day_start(moment: datetime) -> datetime:
    local = moment.astimezone(local_tz())
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def talk_room(owner_id, agent_slug) -> str | None:
    """The owner's private Talk room routed to this agent: exactly one room that is
    both routed to the agent and bound to the owner, otherwise None."""
    settings = get_settings()
    routed = {r.room_token for r in settings.talk_agent_routes if r.agent_slug == agent_slug}
    bound = {b.room_token for b in settings.talk_memory_bindings if b.user_id == owner_id}
    rooms = routed & bound
    return next(iter(rooms)) if len(rooms) == 1 else None


def proactive_enabled(db, owner_id) -> bool:
    row = db.get(NovaProactiveSettings, owner_id)
    return bool(row and row.enabled)


def routine_task_authorized(db, task) -> bool:
    """A routine task still belongs to its owner's routine, and proactive runs are on.

    The caller (memory_owner) separately checks the user is active and has memory on.
    """
    run = db.scalar(select(NovaRoutineRun).where(NovaRoutineRun.task_id == task.id))
    routine = db.get(NovaRoutine, run.routine_id) if run else None
    return bool(routine and run.status == "started" and (run.manual or routine.enabled)
                and routine.user_id == task.owner_user_id == run.user_id and routine.agent_id == task.agent_id
                and proactive_enabled(db, task.owner_user_id))
