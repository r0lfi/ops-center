"""Shared weekly (Monday UTC) admission control for every Ops Center agent; the limit is set in AI settings."""
import json
import uuid
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
from app.core.ai_pricing import rates, token_cost, reported_cost, UnknownPrice
from app.models.ai import AIUsage, AIProvider
from app.models.ai_budget import AIBudgetWeek as Week, AIBudgetReservation as Reservation, AIBudgetSettings

LIMIT_USD = Decimal("20")  # default until an administrator sets one
MIN_LIMIT_USD, MAX_LIMIT_USD = Decimal("1"), Decimal("1000")
WARNING_SHARE = Decimal("0.8")
MAX_INPUT_BOUND = 180000  # strictly below paid long-context tiers


class AIBudgetStopped(RuntimeError):
    pass


def utcnow():
    return datetime.now(timezone.utc)


def week_start(now=None):
    day = (now or utcnow()).astimezone(timezone.utc).date()
    return day - timedelta(days=day.weekday())


def input_bound(system, messages, tools):
    payload = json.dumps({"system": system, "messages": messages, "tools": tools}, ensure_ascii=False)
    # UTF-8 bytes upper-bound ordinary text tokenizers. Protocol/tool framing
    # gets separate headroom; image/audio content is not admitted by this API.
    if any(marker in payload for marker in ('"image_url"', '"input_audio"', '"base64"')):
        raise AIBudgetStopped("Only text requests have reviewed budget bounds")
    return len(payload.encode("utf-8")) + 4096 + 256 * (len(messages) + len(tools))


def history_query(start):
    since = datetime.combine(start, time.min, timezone.utc)
    return (select(AIProvider.kind, AIProvider.base_url, AIUsage.model,
                   func.sum(AIUsage.input_tokens), func.sum(AIUsage.output_tokens), func.count(AIUsage.id))
            .outerjoin(AIProvider, AIUsage.provider_id == AIProvider.id)
            .where(AIUsage.created_at >= since, AIUsage.created_at < since + timedelta(days=7),
                   AIUsage.reservation_id.is_(None))
            .group_by(AIProvider.kind, AIProvider.base_url, AIUsage.model))


def historic_cost(rows):
    total, unknown = Decimal(0), 0
    for kind, base_url, model, inp, out, count in rows:
        try:
            price = rates(kind, model, base_url, ceiling=True)
            # Legacy rows do not retain cache details: deliberately conservative.
            total += token_cost(int(inp or 0), int(out or 0), *price)
        except UnknownPrice:
            unknown += int(count)
    return total, unknown


def warning_for(limit):
    return (limit * WARNING_SHARE).quantize(Decimal("0.01"))


def limit_of(row):
    return Decimal(row.limit_usd) if row is not None else LIMIT_USD


def weekly_limit(db):
    """The current limit, for the worker's synchronous admission path."""
    return limit_of(db.get(AIBudgetSettings, 1))


def view(start, billed=Decimal(0), reserved=Decimal(0), unknown=0, warning_at=None, limit=LIMIT_USD):
    used = billed + reserved
    warning = warning_for(limit)
    return {"limit_usd": float(limit), "warning_usd": float(warning),
            "billed_usd": float(billed), "reserved_usd": float(reserved),
            "remaining_usd": float(max(Decimal(0), limit - used)),
            "week_start": start.isoformat(),
            "reset_at": datetime.combine(start + timedelta(days=7), time.min, timezone.utc).isoformat(),
            # Against the current limit, so raising it mid-week clears the warning.
            "warning": used >= warning,
            "exhausted": used >= limit or unknown > 0,
            "pricing_unknown": unknown}


async def budget_status(db):
    start = week_start()
    limit = limit_of(await db.get(AIBudgetSettings, 1))
    row = await db.get(Week, start)
    if row and row.initialized:
        return view(start, row.billed_usd, row.reserved_usd, row.unpriced_calls, row.warning_at, limit)
    billed, unknown = historic_cost((await db.execute(history_query(start))).all())
    return view(start, billed, unknown=unknown, limit=limit)


def locked_week(db, start):
    db.execute(insert(Week).values(week_start=start, initialized=False, billed_usd=0, reserved_usd=0, unpriced_calls=0).on_conflict_do_nothing(index_elements=[Week.week_start]))
    row = db.execute(select(Week).where(Week.week_start == start).with_for_update().execution_options(populate_existing=True)).scalar_one()
    if not row.initialized:
        row.billed_usd, row.unpriced_calls = historic_cost(db.execute(history_query(start)).all())
        row.initialized = True
    return row


def reserve(db, agent, model, system, messages, tools, output_cap, task_id=None):
    kind = agent.provider.kind
    if kind in ("ollama", "openai_compatible"):
        return None
    try:
        inp_rate, out_rate = rates(kind, model, agent.provider.base_url)
    except UnknownPrice as exc:
        raise AIBudgetStopped(str(exc)) from exc
    bound = input_bound(system, messages, tools)
    if bound > MAX_INPUT_BOUND:
        raise AIBudgetStopped("Request context exceeds the reviewed 180,000-token budget bound; start a focused follow-up")
    if not 1 <= output_cap <= 8192:
        raise AIBudgetStopped("Output cap is outside the reviewed budget range")
    amount = token_cost(bound, output_cap, *rates(kind, model, agent.provider.base_url, ceiling=True))
    start = week_start()
    limit = weekly_limit(db)
    row = locked_week(db, start)
    if row.unpriced_calls or row.billed_usd + row.reserved_usd + amount > limit:
        if row.billed_usd + row.reserved_usd >= warning_for(limit):
            row.warning_at = row.warning_at or utcnow()
        db.commit()
        raise AIBudgetStopped(f"Shared weekly AI budget cannot cover another request (limit ${limit:.2f}, resets Monday 00:00 UTC). Uncertain calls remain reserved; no paid request was started.")
    row.reserved_usd += amount
    if row.billed_usd + row.reserved_usd >= warning_for(limit):
        row.warning_at = row.warning_at or utcnow()
    reservation = Reservation(id=uuid.uuid4(), week_start=start, task_id=uuid.UUID(str(task_id)) if task_id else None,
        agent_id=agent.id, provider_kind=kind, model=model, input_bound=bound, output_cap=output_cap,
        input_rate=inp_rate, output_rate=out_rate, reserved_usd=amount, status="reserved")
    db.add(reservation)
    # Commit before network I/O. A crash or uncertain provider failure retains the amount.
    db.commit()
    return reservation


def settle(db, reservation, input_tokens, output_tokens, *, usage_reported, cache_read=0, cache_write=0, cache_write_1h=0):
    if reservation is None:
        return
    # Always lock week then reservation, matching admission lock order.
    row = locked_week(db, reservation.week_start)
    entry = db.execute(select(Reservation).where(Reservation.id == reservation.id).with_for_update().execution_options(populate_existing=True)).scalar_one()
    if entry.status != "reserved":
        db.commit()
        return
    try:
        billed = reported_cost(entry.provider_kind, entry.model, input_tokens, output_tokens, entry.input_rate, entry.output_rate, cache_read, cache_write, cache_write_1h)
    except ValueError:
        entry.status = "unknown"
        entry.actual_input_tokens, entry.actual_output_tokens = input_tokens, output_tokens
        entry.cache_read_tokens, entry.cache_write_tokens, entry.cache_write_1h_tokens = cache_read, cache_write, cache_write_1h
        if input_tokens > entry.input_bound or output_tokens > entry.output_cap:
            row.unpriced_calls += 1
            # A broken cache breakdown must not hide a known token-cap breach.
            factor = Decimal("2") if entry.provider_kind == "anthropic" else Decimal("1.25") if entry.model.startswith("gpt-5.6-") else Decimal(1)
            upper = token_cost(max(0, input_tokens), max(0, output_tokens), entry.input_rate * factor, entry.output_rate)
            row.billed_usd += max(Decimal(0), upper - entry.reserved_usd)
        db.commit()
        return
    entry.actual_input_tokens, entry.actual_output_tokens = input_tokens, output_tokens
    entry.cache_read_tokens, entry.cache_write_tokens, entry.cache_write_1h_tokens = cache_read, cache_write, cache_write_1h
    if (not usage_reported or (input_tokens == 0 and output_tokens == 0) or input_tokens < 0 or output_tokens < 0 or
            input_tokens > entry.input_bound or output_tokens > entry.output_cap):
        entry.status = "unknown"
        # Bounds violated or usage absent: preserve full reservation and fail
        # closed for the rest of this week if the provider violated its cap.
        if input_tokens > entry.input_bound or output_tokens > entry.output_cap:
            row.unpriced_calls += 1
            actual = billed
            row.billed_usd += max(Decimal(0), actual - entry.reserved_usd)
        db.commit()
        return
    row.reserved_usd -= entry.reserved_usd
    row.billed_usd += billed
    entry.billed_usd, entry.status, entry.settled_at = billed, "settled", utcnow()
    if row.billed_usd + row.reserved_usd >= warning_for(weekly_limit(db)):
        row.warning_at = row.warning_at or utcnow()
    db.commit()


def release_unattempted(db, reservation):
    """Release only after transport proves no HTTP attempt was made.

    Never call this for provider HTTP errors, timeouts during I/O, malformed
    responses, missing usage, or worker crashes. Those remain accounted.
    """
    if reservation is None:
        return
    row = locked_week(db, reservation.week_start)
    entry = db.execute(select(Reservation).where(Reservation.id == reservation.id)
        .with_for_update().execution_options(populate_existing=True)).scalar_one()
    if entry.status == "reserved":
        row.reserved_usd -= entry.reserved_usd
        entry.status, entry.billed_usd, entry.settled_at = "released", Decimal(0), utcnow()
    db.commit()
