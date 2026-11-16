"""Nova routines end to end against a disposable, migrated PostgreSQL.

Runs only with NOVA_TEST_DATABASE_URL pointing at a database named exactly
ops_nova_test (psycopg URL); never point it at an application database:

    NOVA_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_nova_test?host=/run/pg' \\
      PYTHONPATH=backend:. python -m pytest worker_ai/tests/test_nova_routines_pg.py

Claims, locks, routes, delivery and the task gate are real; the agent run,
Celery and Talk are stubs.
"""
import asyncio
import os
import threading
import uuid
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

URL = os.environ.get("NOVA_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_nova_test" not in URL, reason="needs NOVA_TEST_DATABASE_URL for ops_nova_test")


@pytest.fixture(scope="module")
def env():
    from sqlalchemy import create_engine, text
    from sqlalchemy.orm import Session
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    engine = create_engine(URL)
    async_url = URL.replace("postgresql+psycopg", "postgresql+asyncpg")
    with Session(engine) as db:
        suffix = uuid.uuid4().hex[:8]
        owner = db.execute(text("INSERT INTO users (username, password_hash, role, is_active) VALUES (:u, 'x', 'admin', true) RETURNING id"), {"u": f"owner-{suffix}"}).scalar()
        provider = db.execute(text("INSERT INTO ai_providers (slug, kind, display_name, base_url, default_model, enabled) VALUES (:s, 'openai_compatible', 'Synthetic local', 'http://llm.invalid/v1', 'local', true) RETURNING id"), {"s": f"local-{suffix}"}).scalar()
        nova = db.execute(text("UPDATE ai_agents SET provider_id = :p, enabled = true WHERE slug = 'nova' RETURNING id"), {"p": provider}).scalar()
        db.commit()
    yield NS(engine=engine, async_url=async_url, owner=owner, nova=nova, user=NS(id=owner), Session=Session, AsyncSession=AsyncSession,
             async_sessionmaker=async_sessionmaker, create_async_engine=create_async_engine)
    with Session(engine) as db:
        db.execute(text("DELETE FROM ai_tasks WHERE owner_user_id = :o"), {"o": owner})
        db.execute(text("DELETE FROM users WHERE id = :o"), {"o": owner})
        db.commit()


def call(env, route, *args):
    async def run():
        engine = env.create_async_engine(env.async_url)
        try:
            async with env.AsyncSession(engine, expire_on_commit=False) as db:  # as app.db.session
                return await route(*args, db, env.user)
        finally:
            await engine.dispose()
    return asyncio.run(run())


def settings(env, **values):
    from app.models.nova import NovaProactiveSettings
    from app.models.ai_memory import AIMemoryPreference
    with env.Session(env.engine) as db:
        row = db.get(NovaProactiveSettings, env.owner) or NovaProactiveSettings(user_id=env.owner)
        row.enabled = values.get("enabled", True)
        row.quiet_start, row.quiet_end = values.get("quiet", (time(0, 0), time(0, 0)))
        row.max_per_day = values.get("max_per_day", 20)
        db.merge(row)
        pref = db.get(AIMemoryPreference, env.owner) or AIMemoryPreference(user_id=env.owner)
        pref.enabled = values.get("memory", True)
        db.merge(pref)
        db.commit()


def routine(env, schedule="0 7 * * *", channel="web", enabled=True):
    from app.models.nova import NovaRoutine
    with env.Session(env.engine) as db:
        row = NovaRoutine(user_id=env.owner, agent_id=env.nova, name=f"Brief {uuid.uuid4().hex[:4]}", schedule=schedule,
                            instruction="Brief me.", channel=channel, enabled=enabled,
                            created_at=datetime.now(timezone.utc) - timedelta(days=2))
        db.add(row)
        db.commit()
        return row.id


def due_now(schedule="0 7 * * *"):
    from app.core.nova_routines import latest_due
    due = latest_due(schedule, datetime.now(timezone.utc))
    return due, due + timedelta(seconds=30)


def runs(env, routine_id):
    from sqlalchemy import select
    from app.models.nova import NovaRoutineRun
    with env.Session(env.engine) as db:
        return db.execute(select(NovaRoutineRun).where(NovaRoutineRun.routine_id == routine_id)).scalars().all()


def only(env, routine_id, outcomes):
    """Outcomes of other test routines still due this minute are ignored."""
    return outcomes.get(str(routine_id))


def test_a_due_routine_runs_once_even_with_two_schedulers(env):
    from worker_ai.ai.memory import memory_owner
    from worker_ai.ai.routines import tick
    settings(env)
    rid = routine(env)
    due, now = due_now()
    results, barrier = [], threading.Barrier(2)

    def scheduler():
        with env.Session(env.engine) as db:
            barrier.wait()
            results.append(tick(db, now))
    threads = [threading.Thread(target=scheduler) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    [run] = runs(env, rid)
    assert run.status == "started" and run.due_at == due and run.task_id
    enqueued = [task for _, enqueue in results for task in enqueue if task == str(run.task_id)]
    assert enqueued == [str(run.task_id)]
    with env.Session(env.engine) as db:
        assert only(env, rid, tick(db, now)[0]) is None  # a later tick finds it claimed
        assert memory_owner(db, str(run.task_id)) == env.owner
        from app.models.ai import AITask
        task = db.get(AITask, run.task_id)
        assert task.source == "routine" and task.agent_id == env.nova and task.owner_user_id == env.owner


def test_quiet_hours_daily_cap_and_switches_stop_scheduled_runs(env):
    from app.core.nova_routines import local_tz
    from worker_ai.ai.routines import tick
    due, now = due_now()
    local = due.astimezone(local_tz())
    around = ((local - timedelta(hours=1)).time(), (local + timedelta(hours=1)).time())

    settings(env, quiet=around)
    quiet = routine(env)
    with env.Session(env.engine) as db:
        assert only(env, quiet, tick(db, now)[0]) == "skipped: quiet hours"

    from worker_ai.ai.routines import _scheduled_today
    with env.Session(env.engine) as db:
        already = _scheduled_today(db, env.owner, now)  # earlier tests' scheduled runs count today too
    settings(env, max_per_day=already + 1)
    first, second = routine(env), routine(env)
    with env.Session(env.engine) as db:
        outcomes = tick(db, now)[0]
    assert sorted([outcomes[str(first)], outcomes[str(second)]]) == ["skipped: daily limit reached", "started"]

    settings(env, memory=False)
    no_memory = routine(env)
    with env.Session(env.engine) as db:
        assert only(env, no_memory, tick(db, now)[0]) == "skipped: memory is off"

    settings(env, enabled=False)
    off = routine(env)
    with env.Session(env.engine) as db:
        assert only(env, off, tick(db, now)[0]) is None
    assert runs(env, off) == []


def test_a_queued_routine_is_cancelled_when_proactive_runs_are_turned_off(env):
    from app.models.ai import AITask
    from app.models.nova import NovaRoutine
    from worker_ai import tasks
    from worker_ai.ai.memory import memory_owner
    from worker_ai.ai.routines import start_run
    settings(env)
    rid = routine(env, enabled=False)
    with env.Session(env.engine) as db:
        outcome, task_id = start_run(db, db.get(NovaRoutine, rid), datetime.now(timezone.utc), manual=True)
        assert outcome == "started" and memory_owner(db, task_id) == env.owner  # a paused routine can still be run by hand
    settings(env, enabled=False)
    agent_run = MagicMock()
    with patch.object(tasks, "SessionLocal", lambda: env.Session(env.engine)), patch.object(tasks, "run_agent", agent_run):
        tasks._run_agent_task(task_id, None)
    agent_run.assert_not_called()
    with env.Session(env.engine) as db:
        task = db.get(AITask, uuid.UUID(task_id))
        assert task.status == "cancelled" and "turned off" in task.error_message


def test_routes_validate_store_and_gate_run_now(env):
    from fastapi import HTTPException
    from app.api.routes import nova_routines as routes
    settings(env, enabled=False)
    with pytest.raises(HTTPException) as secret:
        call(env, routes.create_routine, routes.RoutineCreate(name="x", schedule="0 7 * * *", instruction="password: aaaaaaaa"))
    assert secret.value.status_code == 422
    with pytest.raises(HTTPException) as often:
        call(env, routes.create_routine, routes.RoutineCreate(name="x", schedule="*/5 * * * *", instruction="Check"))
    assert "at most every 30 minutes" in often.value.detail
    created = call(env, routes.create_routine, routes.RoutineCreate(name=" Morning brief ", schedule="0  7 * * *", instruction="Brief me", channel="talk"))
    assert created["name"] == "Morning brief" and created["schedule"] == "0 7 * * *" and created["next_run_at"] > datetime.now(timezone.utc)
    with pytest.raises(HTTPException) as gated, patch.object(routes, "get_celery_client") as celery:
        call(env, routes.run_routine, created["id"])
    assert gated.value.status_code == 409 and not celery.called
    call(env, routes.update_proactive, routes.ProactiveUpdate(enabled=True, quiet_start=time(22, 0), quiet_end=time(7, 0), max_per_day=3))
    with patch.object(routes, "get_celery_client") as celery:
        assert call(env, routes.run_routine, created["id"]) == {"queued": True}
    celery.return_value.send_task.assert_called_once_with("worker_ai.tasks.run_nova_routine", args=[str(created["id"]), str(env.owner)], queue="ai")
    paused = call(env, routes.update_routine, created["id"], routes.RoutineUpdate(enabled=False))
    assert paused["enabled"] is False and paused["next_run_at"] is None
    listing = call(env, routes.list_routines)
    assert listing["settings"] == {"enabled": True, "quiet_start": "22:00", "quiet_end": "07:00", "max_per_day": 3}
    assert any(r["id"] == created["id"] for r in listing["routines"]) and listing["talk_room"] is False
    other = NS(id=uuid.uuid4())
    with pytest.raises(HTTPException) as foreign:
        asyncio.run(_as(env, other, routes.delete_routine, created["id"]))
    assert foreign.value.status_code == 404
    call(env, routes.delete_routine, created["id"])
    assert all(r["id"] != created["id"] for r in call(env, routes.list_routines)["routines"])


async def _as(env, user, route, *args):
    engine = env.create_async_engine(env.async_url)
    try:
        async with env.AsyncSession(engine, expire_on_commit=False) as db:
            return await route(*args, db, user)
    finally:
        await engine.dispose()


def test_talk_routines_reach_only_the_owners_routed_room_once(env):
    from sqlalchemy import update
    from app.models.ai import AITask
    from app.models.nova import NovaRoutine
    from app.services import talk_watch
    from worker_ai.ai.routines import start_run
    settings(env)
    talk, lonely = routine(env, channel="talk"), routine(env, channel="talk")
    with env.Session(env.engine) as db:
        tasks = [start_run(db, db.get(NovaRoutine, rid), datetime.now(timezone.utc), manual=True)[1] for rid in (talk, lonely)]
        db.execute(update(AITask).where(AITask.id.in_(tasks)).values(status="completed", response_message="Good morning",
                                                                       completed_at=datetime.now(timezone.utc)))
        db.commit()

    async def deliver(rooms):
        engine = env.create_async_engine(env.async_url)
        try:
            with patch.object(talk_watch, "async_session_factory", env.async_sessionmaker(engine, expire_on_commit=False)), \
                 patch.object(talk_watch, "talk_room", lambda owner, slug: rooms.pop(0) if rooms else None), \
                 patch.object(talk_watch, "notify_once", AsyncMock(return_value=True)) as notify:
                await talk_watch.deliver_routines(datetime.now(timezone.utc))
                return notify
        finally:
            await engine.dispose()
    notify = asyncio.run(deliver(["novaroom"]))
    [sent] = notify.call_args_list
    assert sent.args[1] == "novaroom" and sent.args[2].endswith(": Good morning")
    delivered = {r.id: r for rid in (talk, lonely) for r in runs(env, rid)}
    assert sorted(bool(r.delivered_at) for r in delivered.values()) == [False, True]
    assert [r.delivery_error for r in delivered.values() if not r.delivered_at] == ["No private Talk room is routed to nova for this owner."]
    assert asyncio.run(deliver(["novaroom"])).call_count == 0  # delivered and failed runs are not retried
