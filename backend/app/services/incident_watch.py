"""HA incident collection and at-most-one outbound attempt per IM and administrator room."""

import asyncio
import logging
from datetime import timedelta
import httpx
from sqlalchemy import select, text, update
from app.core.config import get_settings
from app.db.session import async_session_factory
from app.models.incidents import IMSettings, IMCondition, Incident, IMDelivery
from app.models.traffic import TrafficSecurityAlert, TrafficCollector
from app.models.user import User
from app.services import incidents as im
from app.services.traffic_settings import load_config as traffic_config, enabled_sources
from app.services import traffic_auth
from app.services.talk_notify import send_talk

log = logging.getLogger("incident.watch")
LOCK = 738143
# A send that never reached Talk is retried; one that may have arrived is not.
RETRY_AFTER = timedelta(minutes=2)
RETRY_WINDOW = timedelta(hours=6)


def never_reached_talk(error):
    """True only when the message cannot have been posted, so a resend cannot duplicate it."""
    if isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)):
        return True
    # Maintenance mode, or the reverse proxy could not reach Nextcloud.
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code in (502, 503)


async def admin_rooms(db):
    if not get_settings().talk_notifications_enabled:
        return set()
    admins = set(
        (
            await db.scalars(
                select(User.id).where(User.is_active.is_(True), User.role == "admin")
            )
        ).all()
    )
    return {
        b.room_token for b in get_settings().talk_memory_bindings if b.user_id in admins
    }


async def collect_once():
    observed = im.utcnow()
    available, alerts = False, []
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get("http://alertmanager:9093/api/v2/alerts")
            response.raise_for_status()
            alerts = response.json()
            available = isinstance(alerts, list) and all(
                isinstance(a, dict) and isinstance(a.get("labels"), dict)
                for a in alerts
            )
    except (httpx.HTTPError, ValueError):
        pass
    async with async_session_factory() as db, db.begin():
        if not await db.scalar(
            text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": LOCK}
        ):
            return
        state = await db.get(IMSettings, 1, with_for_update=True)
        if not state:
            return
        previous = state.value.get("monitor", {}).get("checked_at", 0)
        if observed.timestamp() - previous < 10:
            return
        config = await im.load_config(db)
        rooms = await admin_rooms(db)
        await im.reconcile(
            db,
            "alertmanager",
            im.resource_candidates(alerts) if available else [],
            now=observed,
            complete=available,
            config=config,
            rooms=rooms,
        )
        source_alert = (
            []
            if available
            else [
                dict(
                    fingerprint=im.fingerprint(["monitor", "alertmanager"]),
                    category="monitoring",
                    rule="alert_source_unavailable",
                    resource="Alertmanager",
                    title="Monitoring source unavailable",
                    severity="warning",
                    details={
                        "summary": "Resource state is unknown. No recovery is inferred."
                    },
                )
            ]
        )
        await im.reconcile(
            db,
            "monitor",
            source_alert,
            now=observed,
            complete=True,
            config=config,
            rooms=rooms,
        )
        traffic = await traffic_config(db)
        policy = await traffic_auth.trusted_origins(traffic)
        sources = enabled_sources(traffic)
        source_ids = [s.id for s in sources]
        analysis = await db.get(TrafficCollector, "security")
        analysis_ok = bool(
            analysis
            and analysis.last_success
            and observed.timestamp() - analysis.last_success < 90
            and not analysis.last_error
        )
        rows = (
            await db.scalars(
                select(TrafficSecurityAlert)
                .where(
                    TrafficSecurityAlert.source.in_(source_ids),
                    TrafficSecurityAlert.last_seen
                    >= max(observed.timestamp() - 1200, state.started_at.timestamp()),
                    TrafficSecurityAlert.rule != "ssh_attempt",
                )
                .order_by(TrafficSecurityAlert.id.desc())
                .limit(10001)
            )
        ).all()
        grouped = {name: {} for name in source_ids}
        for row in rows[:10000]:
            auth = row.rule in traffic_auth.TITLES
            if row.rule in (
                "foreign_login",
                "foreign_vpn",
                "foreign_ssh",
                "ssh_rejected",
            ):
                kind = "ssh" if row.rule in ("foreign_ssh", "ssh_rejected") else None
                if traffic_auth.origin_reason(
                    row.ip, row.evidence.get("country"), policy, kind
                ):
                    continue
            key = im.fingerprint(["traffic", row.source, row.rule, row.domain, row.ip])
            if key in grouped[row.source]:
                continue
            # Reviewed historic telemetry must not create a new inbox item on upgrade.
            if row.reviewed_at and not await db.get(IMCondition, key):
                continue
            grouped[row.source][key] = dict(
                fingerprint=key,
                category="authentication" if auth else "traffic",
                rule=row.rule,
                resource=f"{row.domain} / {row.ip}"[:500],
                title=traffic_auth.TITLES.get(
                    row.rule, row.rule.replace("_", " ").title()
                )[:250],
                severity=row.severity if row.severity in im.SEVERITY else "warning",
                details={
                    "source": row.source,
                    "country": row.evidence.get("country", "Unknown"),
                    "summary": str(row.evidence.get("note", ""))[:2000],
                    "signal_id": row.id,
                },
            )
        traffic_ok = True
        for source in sources:
            collector = await db.get(TrafficCollector, source.id)
            complete = bool(
                analysis_ok
                and len(rows) <= 10000
                and collector
                and collector.last_success
                and observed.timestamp() - collector.last_success < 90
                and not collector.last_error
                and not collector.checkpoint.get("backlog")
                and not collector.checkpoint.get("history_gap")
            )
            traffic_ok = traffic_ok and complete
            route_config = (
                config
                if traffic.notify_authentication
                else config.model_copy(
                    update={
                        "categories": [
                            c for c in config.categories if c != "authentication"
                        ]
                    }
                )
            )
            await im.reconcile(
                db,
                "traffic:" + source.id,
                list(grouped[source.id].values()),
                now=observed,
                complete=complete,
                config=route_config,
                rooms=rooms,
            )
        # Disabled/removed sources are unknown, never evidence of recovery.
        known = set((await db.scalars(select(IMCondition.source).distinct())).all())
        for source in (
            known - {"alertmanager", "monitor"} - {"traffic:" + s for s in source_ids}
        ):
            await im.reconcile(
                db, source, [], now=observed, complete=False, config=config, rooms=rooms
            )
        state.value = {
            **state.value,
            "monitor": {
                "checked_at": observed.timestamp(),
                "alertmanager": "ok" if available else "unavailable",
                "traffic": "ok" if traffic_ok and sources else "unavailable",
            },
        }


async def deliver_once():
    now = im.utcnow()
    async with async_session_factory() as db, db.begin():
        # A lost process cannot cause a second attempt. Inspect the channel after uncertain delivery.
        await db.execute(
            update(IMDelivery)
            .where(
                IMDelivery.status == "sending",
                IMDelivery.claimed_at < now - timedelta(seconds=90),
            )
            .values(status="unknown")
        )
        config = await im.load_config(db)
        rooms = {im.fingerprint(room): room for room in await admin_rooms(db)}
        delivery = (
            await db.scalars(
                select(IMDelivery)
                .where(
                    IMDelivery.status == "pending",
                    (IMDelivery.claimed_at.is_(None))
                    | (IMDelivery.claimed_at < now - RETRY_AFTER),
                )
                .order_by(IMDelivery.id)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
        ).first()
        if not delivery:
            return False
        incident = await db.get(Incident, delivery.incident_id, with_for_update=True)
        traffic = await traffic_config(db)
        if (
            incident.status == "completed"
            or not im.selected(config, incident)
            or delivery.room_digest not in rooms
            or (
                incident.category == "authentication"
                and not traffic.notify_authentication
            )
        ):
            delivery.status = "suppressed"
            return True
        room = rooms[delivery.room_digest]
        delivery.status = "sending"
        delivery.claimed_at = now
        ident = delivery.id
        retry_until = incident.created_at + RETRY_WINDOW
        url = get_settings().mcp_public_url.rstrip("/")
        base = url[:-4] if url.endswith("/mcp") else ""
        link = (
            f"{base}/incidents/{incident.id}"
            if base
            else f"Open Ops Center → Incidents → IM-{incident.id:06d}"
        )
        summary = str(incident.details.get("summary", ""))[:1200]
        if config.workflow_enabled:
            message = (
                f"IM-{incident.id:06d} · {incident.severity.upper()} · {incident.title}\n"
                f"{incident.resource}\n{summary}\n"
                f"{link}\nAcknowledge, track or complete this IM in Ops Center. This is its only Talk notification."
            )
        else:
            message = (
                f"🔔 {incident.severity.upper()} · {incident.title}\n"
                f"{incident.resource}\n{summary}\n"
                f"Sent once per occurrence; a new alert follows only after "
                f"{config.recovery_minutes} min of confirmed recovery."
            )
    # The claim above is committed before contacting Talk. Never retry an uncertain HTTP outcome.
    outcome = "sent"
    try:
        await send_talk(room, message)
    except Exception as error:
        if never_reached_talk(error) and im.utcnow() < retry_until:
            outcome = "pending"
            log.warning("IM Talk delivery failed (%s); will retry", type(error).__name__)
        elif never_reached_talk(error):
            outcome = "failed"
            log.error("IM Talk delivery gave up after %s (%s)", RETRY_WINDOW, type(error).__name__)
        else:
            outcome = "unknown"
            log.warning("IM Talk delivery outcome unknown (%s); no automatic resend", type(error).__name__)
    async with async_session_factory() as db, db.begin():
        delivery = await db.get(IMDelivery, ident, with_for_update=True)
        delivery.status = outcome
        delivery.sent_at = im.utcnow() if outcome == "sent" else None
    # Stop this round while Talk is unreachable; the next rows wait for the next loop.
    return outcome != "pending"


async def watch_loop():
    while True:
        try:
            await collect_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("IM collection failed; no recovery inferred")
        try:
            from app.services.incident_agents import investigate_once
            await investigate_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("IM investigation dispatch failed; the same task will be retried")
        try:
            for _ in range(20):
                if not await deliver_once():
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("IM delivery iteration failed")
        await asyncio.sleep(15)
