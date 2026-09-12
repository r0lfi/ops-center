"""Shared PostgreSQL history for both active Ops API nodes."""

import time
from sqlalchemy import select, func, case, delete, or_
from sqlalchemy.dialects.postgresql import insert
from app.services.traffic_settings import load_config, enabled_sources, source_summaries
from app.db.session import async_session_factory
from app.models.traffic import TrafficEntry as E, TrafficCollector as C

FIELDS = (
    "ts",
    "ip",
    "lat",
    "lon",
    "city",
    "country",
    "domain",
    "status",
    "source",
    "kind",
    "suspicious",
    "signal",
)


def serialize(row):
    return {"id": row.event_key, **{k: getattr(row, k) for k in FIELDS}}


async def save_batch(db, name, events, checkpoint, now):
    # Event identities and checkpoints commit together. Retrying after a crash
    # is safe; the unique identity protects against duplicate observations.
    events = [{"signal": None, **row} for row in events]
    for start in range(0, len(events), 250):
        if events[start : start + 250]:
            await db.execute(
                insert(E)
                .values(events[start : start + 250])
                .on_conflict_do_nothing(index_elements=["event_key"])
            )
    await db.execute(
        insert(C)
        .values(name=name, checkpoint=checkpoint, last_success=now, last_error=None)
        .on_conflict_do_update(
            index_elements=["name"],
            set_={"checkpoint": checkpoint, "last_success": now, "last_error": None},
        )
    )


async def cleanup(db, now):
    settings = await load_config(db)
    await db.execute(delete(E).where(E.ts < now - settings.retention_days * 86400))
    boundary = (
        await db.execute(
            select(E.id).order_by(E.id.desc()).offset(settings.max_rows).limit(1)
        )
    ).scalar_one_or_none()
    if boundary is not None:
        await db.execute(delete(E).where(E.id <= boundary))


async def snapshot(
    hours=24, service="all", errors=False, search="", limit=100, offset=0, until=None
):
    now = time.time()
    end = min(until, now) if until is not None else now
    cutoff = end - hours * 3600
    filters = [E.ts >= cutoff, E.ts <= end]
    if service != "all":
        filters.append(E.source == service)
    if errors:
        filters.append(E.suspicious.is_(True))
    if search:
        pattern = (
            "%"
            + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            + "%"
        )
        filters.append(
            or_(
                *[
                    getattr(E, k).ilike(pattern, escape="\\")
                    for k in ("ip", "domain", "country", "city")
                ]
            )
        )
    async with async_session_factory() as db:
        config = await load_config(db)
        source_ids = [s.id for s in enabled_sources(config)]
        rows = (
            (
                await db.execute(
                    select(E)
                    .where(*filters)
                    .order_by(E.ts.desc(), E.id.desc())
                    .offset(offset)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        totals = (
            await db.execute(
                select(
                    func.count(),
                    func.count(func.distinct(E.ip)),
                    func.count(func.distinct(E.country)),
                    func.sum(case((E.suspicious, 1), else_=0)),
                    func.sum(case((E.kind == "wireguard", 1), else_=0)),
                    func.sum(case((E.kind == "http", 1), else_=0)),
                    func.sum(case((E.kind == "ssh", 1), else_=0)),
                )
                .select_from(E)
                .where(*filters)
            )
        ).one()
        countries = (
            await db.execute(
                select(E.country, func.count().label("n"))
                .where(*filters, E.country.is_not(None))
                .group_by(E.country)
                .order_by(func.count().desc())
                .limit(6)
            )
        ).all()
        domains = (
            await db.execute(
                select(E.domain, func.count())
                .where(E.ts >= cutoff, E.ts <= end)
                .group_by(E.domain)
                .order_by(func.count().desc())
                .limit(30)
            )
        ).all()
        width = max(60, int(hours * 3600 / 36))
        bucket = func.floor(E.ts / width) * width
        timeline = (
            await db.execute(
                select(bucket, func.count())
                .where(*filters)
                .group_by(bucket)
                .order_by(bucket)
            )
        ).all()
        collectors = (
            (await db.execute(select(C).where(C.name.in_(source_ids)))).scalars().all()
        )
        oldest = (await db.execute(select(func.min(E.ts)))).scalar_one()
    destinations = {}
    for c in collectors:
        destinations.update(c.checkpoint.get("destinations", {}))
    counts = dict(timeline)
    timeline = [
        (t, counts.get(t, 0))
        for t in range(
            int(cutoff // width) * width, int(end // width) * width + 1, width
        )
    ]
    return {
        "now": now,
        "events": [serialize(e) for e in rows],
        "destinations": destinations,
        "stats": {
            "total": totals[0],
            "clients": totals[1],
            "countries": totals[2],
            "errors": totals[3] or 0,
            "handshakes": totals[4] or 0,
            "http": totals[5] or 0,
            "ssh": totals[6] or 0,
        },
        "countries": [{"name": c, "count": n} for c, n in countries],
        "domains": dict(domains),
        "timeline": [{"ts": t, "count": n} for t, n in timeline],
        "enabled": config.enabled,
        "sources": source_summaries(config, collectors),
        "retention_days": config.retention_days,
        "max_rows": config.max_rows,
        "oldest": oldest,
        "offset": offset,
        "limit": limit,
    }


async def recent(since):
    async with async_session_factory() as db:
        config = await load_config(db)
        source_ids = [s.id for s in enabled_sources(config)]
        rows = (
            (
                await db.execute(
                    select(E).where(E.ts > since).order_by(E.ts.desc()).limit(1000)
                )
            )
            .scalars()
            .all()
        )
        collectors = (
            (await db.execute(select(C).where(C.name.in_(source_ids)))).scalars().all()
        )
    destinations = {}
    for c in collectors:
        destinations.update(c.checkpoint.get("destinations", {}))
    return {
        "now": time.time(),
        "events": [serialize(e) for e in rows],
        "destinations": destinations,
    }
