"""Evidence-based traffic signals. Never blocks clients or asserts a compromise."""

import asyncio
import hashlib
import logging
import time
from collections import defaultdict
from bisect import bisect_left
from sqlalchemy import select, func, text, delete, or_
from app.db.session import async_session_factory
from app.core.config import get_settings
from app.services import traffic_auth
from app.services.traffic_settings import load_config, enabled_sources, source_summaries
from app.models.traffic import (
    TrafficEntry as E,
    TrafficCollector as C,
    TrafficSecurityAlert as A,
)

log = logging.getLogger("traffic.security")
LOCK = 738105
MAX_SCAN = 60000
TITLES = {
    "auth_burst": "Repeated login rejections",
    "auth_distributed": "Login rejections from multiple clients",
    "success_after_failures": "Successful login after repeated rejections",
    "path_scan": "Repeated sensitive-path probes",
    "error_burst": "High HTTP error rate",
    "traffic_spike": "Traffic above the recent baseline",
    "new_vpn_endpoint": "New VPN endpoint",
    "new_login_origin": "Successful login from a new client",
}

TITLES.update(traffic_auth.TITLES)


def detect(events, baseline, now, baseline_ready=False):
    """Pure rolling-window rules; ordering is by event time, not arrival order."""
    groups = defaultdict(list)
    for e in events:
        if e["kind"] != "ssh" and now - 1200 <= e["ts"] <= now:
            groups[(e["domain"], e["ip"])].append(e)
    alerts = []

    def add(rule, domain, ip, severity, count, ts, **evidence):
        alerts.append(
            dict(
                rule=rule,
                domain=domain,
                ip=ip,
                severity=severity,
                count=count,
                last_seen=ts,
                evidence=evidence,
            )
        )

    domains = defaultdict(list)
    for (domain, ip), rows in groups.items():
        rows.sort(key=lambda e: e["ts"])
        recent = [e for e in rows if e["ts"] >= now - 300 and e["kind"] == "http"]
        if recent:
            domains[domain].extend(recent)
            failed = [
                e
                for e in recent
                if e.get("signal") in ("auth_failure", "auth_throttled")
            ]
            probes = [e for e in recent if e.get("signal") == "probe"]
            errors = [e for e in recent if (e.get("status") or 0) >= 400]
            if len(failed) >= 10:
                add(
                    "auth_burst",
                    domain,
                    ip,
                    "warning",
                    len(failed),
                    failed[-1]["ts"],
                    window_seconds=300,
                    threshold=10,
                    note="Rejected login requests; may include proxy rate limits.",
                )
            if len(probes) >= 20:
                add(
                    "path_scan",
                    domain,
                    ip,
                    "warning",
                    len(probes),
                    probes[-1]["ts"],
                    window_seconds=300,
                    threshold=20,
                    note="Recognized sensitive paths; responses do not prove access.",
                )
            if len(errors) >= 100 and len(errors) / len(recent) >= 0.5:
                add(
                    "error_burst",
                    domain,
                    ip,
                    "warning",
                    len(errors),
                    errors[-1]["ts"],
                    window_seconds=300,
                    total=len(recent),
                    note="Can also indicate a broken client or service.",
                )
        failure_times = [e["ts"] for e in rows if e.get("signal") == "auth_failure"]
        for success in [
            e
            for e in rows
            if e.get("signal") == "auth_success" and e["ts"] >= now - 300
        ]:
            failures = bisect_left(failure_times, success["ts"]) - bisect_left(
                failure_times, success["ts"] - 900
            )
            if failures >= 5:
                add(
                    "success_after_failures",
                    domain,
                    ip,
                    "high",
                    failures,
                    success["ts"],
                    window_seconds=900,
                    threshold=5,
                    note="Application returned a successful authentication response. Same IP, not necessarily the same account; investigate.",
                )
                break
    for domain, rows in domains.items():
        failed = [
            e for e in rows if e.get("signal") in ("auth_failure", "auth_throttled")
        ]
        clients = len({e["ip"] for e in failed})
        if len(failed) >= 30 and clients >= 5:
            add(
                "auth_distributed",
                domain,
                "multiple",
                "warning",
                len(failed),
                max(e["ts"] for e in failed),
                window_seconds=300,
                clients=clients,
                note="Possible distributed guessing; account names are not collected.",
            )
        expected = baseline.get(domain, 0) / 12
        if baseline_ready and len(rows) >= 300 and len(rows) > max(20, expected) * 5:
            add(
                "traffic_spike",
                domain,
                "multiple",
                "warning",
                len(rows),
                max(e["ts"] for e in rows),
                window_seconds=300,
                baseline_per_five_minutes=round(expected, 1),
                note="Over 5x the preceding hour; streaming or legitimate activity can cause this.",
            )
    return alerts


async def persist_alert(db, candidate, now):
    # A rolling one-hour cooldown spans wall-clock bucket boundaries and HA nodes.
    previous = (
        await db.execute(
            select(A)
            .where(
                A.source == candidate.get("source"),
                A.rule == candidate["rule"],
                A.domain == candidate["domain"],
                A.ip == candidate["ip"],
                A.created_at >= now - 3600,
            )
            .order_by(A.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if previous:
        previous.last_seen = max(previous.last_seen, candidate["last_seen"])
        previous.count = max(previous.count, candidate["count"])
        previous.evidence = candidate["evidence"]
        return previous
    row = A(**candidate, created_at=now)
    db.add(row)
    return row


async def scan_once(now=None):
    now = time.time() if now is None else now
    config = await load_config()
    sources = enabled_sources(config)
    if not sources:
        return
    source_ids = [s.id for s in sources]
    policy = await traffic_auth.trusted_origins(config)
    async with async_session_factory() as db, db.begin():
        if not await db.scalar(
            text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": LOCK}
        ):
            return
        state = await db.get(C, "security")
        if state and state.last_success and now - state.last_success < 5:
            return
        if state is None:
            state = C(name="security", checkpoint={"started_at": now, "cursor": 0})
            db.add(state)
        cp = dict(state.checkpoint)
        max_id = await db.scalar(select(func.max(E.id))) or 0
        rows = (
            (
                await db.execute(
                    select(E)
                    .where(E.source.in_(source_ids), E.ts >= now - 1200, E.ts <= now)
                    .order_by(E.ts.desc(), E.id.desc())
                    .limit(MAX_SCAN + 1)
                )
            )
            .scalars()
            .all()
        )
        events = [
            {
                "ts": e.ts,
                "ip": e.ip,
                "domain": e.domain,
                "status": e.status,
                "kind": e.kind,
                "signal": e.signal,
                "source": e.source,
            }
            for e in rows[:MAX_SCAN]
        ]
        # Baselines and cooldown identities are isolated by source. Two
        # registered servers can legitimately serve the same hostname.
        baseline_rows = (
            await db.execute(
                select(E.source, E.domain, func.count())
                .where(
                    E.source.in_(source_ids),
                    E.kind == "http",
                    E.ts >= now - 3900,
                    E.ts < now - 300,
                )
                .group_by(E.source, E.domain)
            )
        ).all()
        ready = now - cp["started_at"] >= 3900
        candidates = []
        for source_id in source_ids:
            baseline = {
                domain: count
                for name, domain, count in baseline_rows
                if name == source_id
            }
            candidates.extend(
                {**item, "source": source_id}
                for item in detect(
                    [e for e in events if e["source"] == source_id],
                    baseline,
                    now,
                    ready,
                )
            )
        # Do not alert retrospectively about activity from before this feature started.
        candidates = [c for c in candidates if c["last_seen"] >= cp["started_at"]]
        for candidate in sorted(candidates, key=lambda c: c["severity"] != "high")[
            :200
        ]:
            await persist_alert(db, candidate, now)
        auth_overflow = await traffic_auth.scan(db, cp, max_id, now, policy)
        state.last_success = now
        state.last_error = (
            "Analysis capacity reached; some activity is not evaluated"
            if len(rows) > MAX_SCAN or auth_overflow or len(candidates) > 200
            else None
        )
        cp.update(
            cursor=max_id, baseline_ready=ready, examined=min(len(rows), MAX_SCAN)
        )
        state.checkpoint = cp
        await db.execute(delete(A).where(A.created_at < now - 30 * 86400))
        boundary = await db.scalar(
            select(A.id).order_by(A.id.desc()).offset(10000).limit(1)
        )
        if boundary is not None:
            await db.execute(delete(A).where(A.id <= boundary))


async def notify_pending():
    """Durable pending alerts; HA lock + existing Talk deduplication. Authentication alerts bypass the aggregate one-minute digest delay."""
    from app.models.user import User
    from app.services.talk_watch import notify_once

    if not get_settings().talk_notifications_enabled:
        return
    config = await load_config()
    source_ids = [s.id for s in enabled_sources(config)]
    if not source_ids:
        return
    now = time.time()
    async with async_session_factory() as db, db.begin():
        if not await db.scalar(text("SELECT pg_try_advisory_xact_lock(738105)")):
            return
        state = await db.get(C, "security")
        if not state:
            return
        admins = set(
            (
                await db.execute(
                    select(User.id).where(
                        User.is_active.is_(True), User.role == "admin"
                    )
                )
            ).scalars()
        )
        rooms = {
            b.room_token
            for b in get_settings().talk_memory_bindings
            if b.user_id in admins
        }
        if not rooms:
            return
        notification_filters = [
            A.source.in_(source_ids),
            A.rule != "ssh_attempt",
            A.notified_at.is_(None),
            A.reviewed_at.is_(None),
            A.created_at >= now - 86400,
        ]
        if not config.notify_authentication:
            notification_filters.append(A.rule.not_in(tuple(traffic_auth.TITLES)))
        if now - state.checkpoint.get("last_notice", 0) < 60:
            notification_filters.append(A.rule.in_(tuple(traffic_auth.TITLES)))
        rows = (
            (
                await db.execute(
                    select(A)
                    .where(*notification_filters)
                    .order_by((A.severity == "high").desc(), A.created_at)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        if not rows:
            return
        key = hashlib.sha256(",".join(str(a.id) for a in rows).encode()).hexdigest()
        message = (
            "Ops Center authentication/security alert:\n"
            + "\n".join(
                f"• {a.severity.upper()}: {TITLES[a.rule]} — {a.domain}, IP {a.ip}, country {a.evidence.get('country','Unknown')}, observations {a.count}"
                for a in rows
            )
            + "\nOpen Traffic Map → Security signals for times and evidence. No automatic blocking."
        )
        for room in rooms:
            await notify_once(f"traffic-security:{room}:{key}", room, message)
        for a in rows:
            a.notified_at = now
        state.checkpoint = {
            **state.checkpoint,
            "last_notice": (
                now
                if now - state.checkpoint.get("last_notice", 0) >= 60
                else state.checkpoint.get("last_notice", 0)
            ),
            "notification_error": None,
        }


async def security_loop():
    while True:
        try:
            await scan_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("Traffic security analysis failed; retrying")
            try:
                async with async_session_factory() as db, db.begin():
                    state = await db.get(C, "security")
                    if state:
                        state.last_error = "Security analysis failed; retrying"
            except Exception:
                pass
        try:
            await notify_pending()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("Traffic security Talk delivery failed; retained for retry")
            try:
                async with async_session_factory() as db, db.begin():
                    state = await db.get(C, "security")
                    if state:
                        state.checkpoint = {
                            **state.checkpoint,
                            "notification_error": "Talk delivery failed; retrying",
                        }
            except Exception:
                pass
        await asyncio.sleep(2)


async def security_snapshot(service="all", hours=24, auth_result="all", auth_offset=0):
    now = time.time()
    config = await load_config()
    source_ids = [s.id for s in enabled_sources(config)]
    ssh_failures = [
        s.id for s in enabled_sources(config) if s.kind == "ssh" and s.ssh_failures
    ]
    filters = [
        A.source.in_(source_ids),
        A.created_at >= now - hours * 3600,
        A.rule != "ssh_attempt",
    ]
    ef = [
        E.source.in_(source_ids),
        or_(E.kind != "ssh", E.signal == "auth_success", E.source.in_(ssh_failures)),
        E.ts >= now - hours * 3600,
        or_(E.signal.in_(traffic_auth.AUTH_SIGNALS), E.kind == "wireguard"),
    ]
    if service != "all":
        filters.append(A.source == service)
        ef.append(E.source == service)
    result_filters = {
        "failed": E.signal.in_(("auth_failure", "auth_throttled", "auth_attempt")),
        "success": E.signal == "auth_success",
        "vpn": E.kind == "wireguard",
    }
    selected = (
        ef + [result_filters[auth_result]] if auth_result in result_filters else ef
    )
    async with async_session_factory() as db:
        rows = (
            (
                await db.execute(
                    select(A)
                    .where(*filters)
                    .order_by(A.created_at.desc(), A.id.desc())
                    .limit(100)
                )
            )
            .scalars()
            .all()
        )
        total = await db.scalar(select(func.count()).select_from(A).where(*filters))
        pending = await db.scalar(
            select(func.count()).select_from(A).where(*filters, A.reviewed_at.is_(None))
        )
        logins = (
            (
                await db.execute(
                    select(E)
                    .where(*ef, E.signal == "auth_success")
                    .order_by(E.ts.desc())
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        auth_total = await db.scalar(
            select(func.count()).select_from(E).where(*selected)
        )
        authentication = (
            (
                await db.execute(
                    select(E)
                    .where(*selected)
                    .order_by(E.ts.desc(), E.id.desc())
                    .offset(auth_offset)
                    .limit(20)
                )
            )
            .scalars()
            .all()
        )
        state = await db.get(C, "security")
    cp = state.checkpoint if state else {}
    policy = cp.get(
        "auth_policy",
        {
            "countries": [],
            "dns_names": [],
            "addresses": [],
            "checked_at": None,
            "error": "Authentication policy is starting",
        },
    )
    return {
        "now": now,
        "total": total,
        "unreviewed": pending,
        "last_success": state.last_success if state else None,
        "error": state.last_error if state else None,
        "started_at": cp.get("started_at"),
        "baseline_ready": cp.get("baseline_ready", False),
        "notification_error": cp.get("notification_error"),
        "talk_enabled": get_settings().talk_notifications_enabled and config.enabled,
        "auth_policy": policy,
        "auth_started_at": cp.get("auth_started_at"),
        "auth_total": auth_total,
        "auth_offset": auth_offset,
        "authentication": [
            {
                k: getattr(e, k)
                for k in ("id", "ts", "ip", "domain", "country", "status")
            }
            | {
                "outcome": traffic_auth.outcome({"kind": e.kind, "signal": e.signal}),
                "origin_reason": traffic_auth.origin_reason(
                    e.ip, e.country, policy, e.kind
                ),
            }
            for e in authentication
        ],
        "alerts": [
            {
                k: getattr(a, k)
                for k in (
                    "id",
                    "rule",
                    "severity",
                    "domain",
                    "ip",
                    "count",
                    "created_at",
                    "last_seen",
                    "evidence",
                    "reviewed_at",
                    "reviewed_by",
                    "notified_at",
                )
            }
            | {"title": TITLES[a.rule]}
            for a in rows
        ],
        "logins": [
            {"ts": e.ts, "ip": e.ip, "domain": e.domain, "country": e.country}
            for e in logins
        ],
    }


async def authentication_banner():
    """Global live authentication summary; independent of map filters and pause."""
    now = time.time()
    config = await load_config()
    source_ids = [s.id for s in enabled_sources(config)]
    ssh_failures = [
        s.id for s in enabled_sources(config) if s.kind == "ssh" and s.ssh_failures
    ]
    async with async_session_factory() as db:
        alerts = (
            (
                await db.execute(
                    select(A)
                    .where(
                        A.source.in_(source_ids),
                        A.reviewed_at.is_(None),
                        A.created_at >= now - 86400,
                        A.rule.in_(tuple(traffic_auth.TITLES)),
                    )
                    .order_by((A.severity == "high").desc(), A.last_seen.desc())
                    .limit(5)
                )
            )
            .scalars()
            .all()
        )
        events = (
            (
                await db.execute(
                    select(E)
                    .where(
                        E.source.in_(source_ids),
                        E.ts >= now - 300,
                        E.ts <= now,
                        E.signal.in_(traffic_auth.AUTH_SIGNALS),
                        or_(
                            E.kind != "ssh",
                            E.signal == "auth_success",
                            E.source.in_(ssh_failures),
                        ),
                    )
                    .order_by(E.ts.desc(), E.id.desc())
                    .limit(5)
                )
            )
            .scalars()
            .all()
        )
        state = await db.get(C, "security")
        collectors = (
            (await db.execute(select(C).where(C.name.in_(source_ids)))).scalars().all()
        )
    return {
        "now": now,
        "enabled": bool(source_ids),
        "last_success": state.last_success if state else None,
        "error": (
            (state.last_error if state else "Analysis is starting")
            if source_ids
            else None
        ),
        "sources": source_summaries(config, collectors),
        "alerts": [
            {
                k: getattr(a, k)
                for k in (
                    "id",
                    "severity",
                    "domain",
                    "ip",
                    "last_seen",
                    "evidence",
                    "notified_at",
                )
            }
            | {"title": TITLES[a.rule]}
            for a in alerts
        ],
        "observations": [
            {
                "id": e.id,
                "ts": e.ts,
                "ip": e.ip,
                "country": e.country,
                "domain": e.domain,
                "kind": e.kind,
                "outcome": traffic_auth.outcome({"kind": e.kind, "signal": e.signal}),
            }
            for e in events
        ],
    }
