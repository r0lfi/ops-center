"""Interactive Talk progress, task replies and operational approval outcomes."""

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, update
from app.core.config import get_settings
from app.core.nova_routines import talk_room
from app.core.talk_memory import task_binding_valid
from app.db.session import async_session_factory
from app.models.ai import AITask, AIAction, AIAgent
from app.models.nova import NovaProactiveSettings, NovaRoutine, NovaRoutineRun
from app.models.user import User
from app.services.redis_client import get_redis_client
from app.services.talk_notify import send_talk
from app.services.celery_client import get_celery_client

log = logging.getLogger("talk.watch")


async def notify_once(key, token, message, *, ttl=604800):
    if len(message) > 5600:
        chunks = [message[i : i + 5500] for i in range(0, len(message), 5500)]
        for i, chunk in enumerate(chunks):
            await notify_once(
                f"{key}:part:{i}", token, f"({i+1}/{len(chunks)}) " + chunk, ttl=ttl
            )
        return True
    redis = get_redis_client()
    key = "ops:talk:notice:" + key
    lock = key + ":lock"
    claim = hashlib.sha256(str(datetime.now(timezone.utc)).encode()).hexdigest()
    try:
        if await redis.exists(key) or not await redis.set(lock, claim, nx=True, ex=30):
            return False
        try:
            await send_talk(token, message)
            await redis.set(key, "sent", ex=ttl)
            return True
        finally:
            await redis.eval(
                "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
                1,
                lock,
                claim,
            )
    finally:
        await redis.aclose()


async def poll_once():
    now = datetime.now(timezone.utc)
    from app.services.incidents import load_config as im_config

    async with async_session_factory() as db:
        progress_enabled = (await im_config(db)).talk_progress
    redis = get_redis_client()
    try:
        await redis.set("ops:talk:feature-start", now.isoformat(), nx=True)
        raw = await redis.get("ops:talk:feature-start")
        since = datetime.fromisoformat(raw.decode() if isinstance(raw, bytes) else raw)
    finally:
        await redis.aclose()
    async with async_session_factory() as db:
        cutoff = now - timedelta(seconds=1250)
        await db.execute(
            update(AIAction)
            .where(AIAction.status == "pending", AIAction.expires_at <= now)
            .values(status="expired")
        )
        await db.execute(
            update(AITask)
            .where(AITask.status == "running", AITask.started_at < cutoff)
            .values(
                status="failed",
                completed_at=now,
                error_message="Worker exceeded hard execution limit",
                response_message="Oppgaven stoppet etter tidsgrensen eller mistet worker. Ingen automatisk gjentakelse av endringer.",
            )
        )
        await db.execute(
            update(AIAction)
            .where(AIAction.status == "executing", AIAction.executed_at < cutoff)
            .values(
                status="failed",
                result={
                    "error": "Worker lost or timed out; actual action outcome is UNKNOWN. Inspect before retry."
                },
            )
        )
        await db.execute(
            update(AIAgent)
            .where(
                AIAgent.status.in_(("working", "waiting", "investigating")),
                AIAgent.last_activity_at < cutoff,
            )
            .values(
                status="error",
                error_message="No agent activity beyond hard task limit",
                current_task=None,
            )
        )
        await db.commit()
        tasks = list(
            (
                await db.execute(
                    select(AITask)
                    .where(
                        AITask.source == "talk",
                        AITask.created_at > now - timedelta(days=1),
                    )
                    .order_by(AITask.created_at.desc())
                    .limit(200)
                )
            ).scalars()
        )
        valid = {}
        for task in tasks:
            if not task_binding_valid(task):
                continue
            user = await db.get(User, task.owner_user_id)
            if not user or not user.is_active:
                continue
            room = task.conversation_key.removeprefix("talk:")
            valid[task.id] = (task, room)
            age = (now - task.created_at).total_seconds()
            if (
                get_settings().talk_notifications_enabled
                and progress_enabled
                and task.status in ("queued", "running")
                and age > 30
            ):
                stage = (
                    "Venter på ledig agent"
                    if task.status == "queued"
                    else "Undersøker fortsatt"
                )
                await notify_once(
                    f"progress:{task.id}:{int(age//45)}",
                    room,
                    f"{stage} – oppgave {str(task.id)[:8]}, {int(age)} sekunder. Ingen endring blir kjørt uten nødvendig godkjenning.",
                )
            if task.status == "queued" and age > 60:
                # Recover committed tasks whose initial broker dispatch failed.
                redis = get_redis_client()
                try:
                    if await redis.set(
                        f"ops:talk:requeue:{task.id}", 1, nx=True, ex=120
                    ):
                        get_celery_client().send_task(
                            "worker_ai.tasks.run_talk_task",
                            args=[
                                str(task.id),
                                room,
                                get_settings().talk_backend_url,
                                "",
                            ],
                            queue="ai",
                        )
                finally:
                    await redis.aclose()
            if (
                task.status in ("completed", "failed", "cancelled")
                and task.completed_at
                and task.created_at >= since
            ):
                text = task.response_message or (
                    "Oppgaven ble stoppet."
                    if task.status == "cancelled"
                    else "Oppgaven feilet. Se oppgaven i Ops Center for detaljer."
                )
                await notify_once(
                    f"final:{task.id}", room, f"Oppgave {str(task.id)[:8]}: {text}"
                )
        if valid:
            actions = list(
                (
                    await db.execute(
                        select(AIAction).where(AIAction.task_id.in_(valid))
                    )
                ).scalars()
            )
            for action in actions:
                task, room = valid[action.task_id]
                if (
                    action.status == "pending"
                    and action.expires_at
                    and action.expires_at > now
                ):
                    args = json.dumps(action.arguments, ensure_ascii=False, indent=2)
                    if len(args) > 2500:
                        message = f"{action.request_code}: Handlingen er for omfattende for Talk-godkjenning. Se hele innholdet i Ops Center."
                    else:
                        message = (
                            f"Godkjenning kreves: {action.request_code}\n{action.action}\nRisiko: {action.risk}\n"
                            f"Verktøy: {action.tool}\nArgumenter:\n{args}\n"
                            f"Utløper {action.expires_at.strftime('%H:%M UTC')}.\n"
                            f"Svar: godkjenn {action.request_code}\neller: avvis {action.request_code}"
                        )
                    await notify_once(f"action:{action.id}:preview", room, message)
                elif (
                    action.status in ("executed", "failed", "expired", "rejected")
                    and action.requested_at >= since
                ):
                    status = {
                        "executed": "Utført",
                        "failed": "Feilet / resultat kan være ukjent – kontroller i Ops Center før nytt forsøk",
                        "expired": "Utløpt",
                        "rejected": "Avvist",
                    }[action.status]
                    await notify_once(
                        f"action:{action.id}:terminal",
                        room,
                        f"{action.request_code}: {status}. {action.action}",
                    )
                elif (
                    action.status == "approved"
                    and action.approved_at
                    and (now - action.approved_at).total_seconds() > 30
                ):
                    redis = get_redis_client()
                    try:
                        if await redis.set(
                            f"ops:action:requeue:{action.id}", 1, nx=True, ex=120
                        ):
                            get_celery_client().send_task(
                                "worker_ai.tasks.execute_action_task",
                                args=[str(action.id)],
                                queue="ai",
                            )
                    finally:
                        await redis.aclose()


ROUTINE_DELIVERY_WINDOW = timedelta(hours=6)


async def deliver_routines(now):
    """Post finished Talk routines of nova to the owner's routed private room, once each.

    Only a room both routed to the agent and bound to the owner qualifies
    (app.core.nova_routines.talk_room); without one the run records why
    and stays visible on the nova page only.
    """
    async with async_session_factory() as db:
        rows = (await db.execute(
            select(NovaRoutineRun, AITask, NovaRoutine.name, AIAgent.slug)
            .join(AITask, AITask.id == NovaRoutineRun.task_id)
            .join(NovaRoutine, NovaRoutine.id == NovaRoutineRun.routine_id)
            .join(AIAgent, AIAgent.id == AITask.agent_id)
            .where(NovaRoutineRun.channel == "talk", NovaRoutineRun.status == "started",
                   NovaRoutineRun.delivered_at.is_(None), NovaRoutineRun.delivery_error.is_(None),
                   AITask.status.in_(("completed", "failed")), AITask.completed_at > now - ROUTINE_DELIVERY_WINDOW)
        )).all()
        for run, task, name, slug in rows:
            user = await db.get(User, task.owner_user_id) if task.owner_user_id else None
            settings = await db.get(NovaProactiveSettings, task.owner_user_id) if user else None
            if not user or not user.is_active or not settings or not settings.enabled:
                run.delivery_error = "Proactive runs were turned off before delivery."
                continue
            room = talk_room(task.owner_user_id, slug)
            if room is None:
                run.delivery_error = "No private Talk room is routed to nova for this owner."
                continue
            text = task.response_message if task.status == "completed" and task.response_message else (
                "The routine could not finish. See it on the Nova page in Ops Center.")
            try:
                # False: already sent, or the other API node holds the claim and records delivery itself.
                if await notify_once(f"routine:{run.id}", room, f"{name}: {text}"):
                    run.delivered_at = now
            except Exception:
                log.exception("Talk delivery of nova routine run %s failed; retrying", run.id)
        await db.commit()


async def watch_loop():
    while True:
        try:
            # Interactive replies and approvals must survive disabling proactive alerts.
            await poll_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Talk monitoring iteration failed; retrying")
        try:
            await deliver_routines(datetime.now(timezone.utc))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Nova routine delivery failed; retrying")
        await asyncio.sleep(15)
