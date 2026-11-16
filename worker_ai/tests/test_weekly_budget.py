"""Real PostgreSQL ledger races; no paid provider calls."""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace as NS
from unittest.mock import patch
import pytest
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session
from app.models.user import User
from app.models.ai import AIProvider, AIAgent, AITask, AIUsage
from app.models.ai_budget import AIBudgetWeek as Week, AIBudgetReservation as Reservation, AIBudgetSettings
from app.core.ai_pricing import rates, token_cost, reported_cost, UnknownPrice
from app.services.ai_budget import reserve, settle, week_start, AIBudgetStopped, view

TABLES = [User.__table__, AIProvider.__table__, AIAgent.__table__, AITask.__table__, AIUsage.__table__, Week.__table__, Reservation.__table__, AIBudgetSettings.__table__]


@pytest.fixture
def database():
    url = os.getenv("AI_BUDGET_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Dedicated weekly budget PostgreSQL database not configured")
    engine = create_engine(url)
    assert engine.url.database == "ops_budget_test", "Refusing to modify any other database"
    from app.db.base import Base
    Base.metadata.drop_all(engine, tables=TABLES)
    Base.metadata.create_all(engine, tables=TABLES)
    with Session(engine, expire_on_commit=False) as db:
        provider = AIProvider(slug="test", kind="anthropic", display_name="Test", enabled=True, default_model="claude-sonnet-5")
        db.add(provider)
        db.flush()
        agent = AIAgent(slug="linux", name="Linux", provider_id=provider.id, enabled=True, system_prompt="Investigate", max_tool_calls=64)
        db.add(agent)
        db.commit()
        yield NS(engine=engine, db=db, provider=provider, agent=agent)
    engine.dispose()


def request(d, db=None, agent=None):
    return reserve(db or d.db, agent or d.agent, "claude-sonnet-5", "Investigate", [{"role":"user", "content":"Check status"}], [], 4096)


def test_monday_utc_and_week_rollover():
    assert str(week_start(datetime(2026,9,20,23,59,tzinfo=timezone.utc))) == "2026-09-14"
    assert str(week_start(datetime(2026,9,21,0,0,tzinfo=timezone.utc))) == "2026-09-21"


def test_exact_model_prices_and_unknown_paid_endpoints():
    assert rates("openai", "gpt-5.6-luna") == (Decimal("0.20"), Decimal("1.20"))
    assert rates("anthropic", "claude-sonnet-5") == (Decimal("2"), Decimal("10"))
    for kind, model, url in [("openai", "gpt-4.1-huge", None), ("openai", "gpt-4o", "https://unreviewed"), ("unknown", "gpt-4o", None)]:
        with pytest.raises(UnknownPrice):
            rates(kind, model, url)
    assert rates("ollama", "anything") == (0,0)


def test_historic_usage_is_included_once_and_settlement_idempotent(database):
    d=database
    d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5", input_tokens=1000, output_tokens=200))
    d.db.commit()
    entry=request(d)
    week=d.db.get(Week, week_start())
    assert week.billed_usd == Decimal("0.006")
    assert week.reserved_usd == entry.reserved_usd
    settle(d.db, entry, 100, 20, usage_reported=True)
    settle(d.db, entry, 100, 20, usage_reported=True)
    assert week.reserved_usd == 0 and week.billed_usd == Decimal("0.0064")
    request(d)
    assert week.billed_usd == Decimal("0.0064")


@pytest.mark.parametrize("reported,inp,out", [(False,100,20),(True,0,0)])
def test_missing_or_zero_usage_retains_reservation(database,reported,inp,out):
    d=database
    entry=request(d)
    settle(d.db, entry, inp,out, usage_reported=reported)
    assert d.db.get(Week, week_start()).reserved_usd == entry.reserved_usd
    assert d.db.get(Reservation, entry.id).status == "unknown"


def test_unknown_old_price_fails_closed(database):
    d=database
    d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="new-unpriced-model", input_tokens=1000, output_tokens=200))
    d.db.commit()
    with pytest.raises(AIBudgetStopped):
        request(d)
    assert d.db.get(Week, week_start()).unpriced_calls == 1
    assert d.db.scalar(select(func.count()).select_from(Reservation)) == 0


def test_parallel_workers_cannot_overspend(database):
    d=database
    first=request(d)
    week=d.db.get(Week,week_start())
    week.billed_usd=Decimal("20") - first.reserved_usd * Decimal("2.5")
    d.db.commit()
    def contender(_):
        with Session(d.engine,expire_on_commit=False) as db:
            agent=db.get(AIAgent,d.agent.id)
            try:
                request(d,db,agent)
                return "reserved"
            except AIBudgetStopped:
                return "denied"
    with ThreadPoolExecutor(max_workers=4) as pool:
        result=list(pool.map(contender,range(4)))
    assert result.count("reserved") == 1 and result.count("denied") == 3
    d.db.expire_all()
    week=d.db.get(Week,week_start())
    assert week.billed_usd+week.reserved_usd <= 20
    assert week.warning_at is not None


def test_overreported_usage_blocks_week_and_records_excess(database):
    d=database
    entry=request(d)
    actual=token_cost(10000000,10000000,entry.input_rate,entry.output_rate)
    settle(d.db,entry,10000000,10000000,usage_reported=True)
    week=d.db.get(Week,week_start())
    assert week.billed_usd+week.reserved_usd == actual and week.unpriced_calls == 1
    with pytest.raises(AIBudgetStopped): request(d)


def test_old_week_reservation_settles_into_old_week(database):
    d=database
    last_week=datetime.now(timezone.utc)-timedelta(days=7)
    with patch("app.services.ai_budget.utcnow",return_value=last_week): entry=request(d)
    new=request(d)
    settle(d.db,entry,100,20,usage_reported=True)
    assert d.db.get(Week,new.week_start).billed_usd == 0
    assert d.db.get(Week,entry.week_start).billed_usd > 0


def test_paid_transport_never_retries_under_one_reservation():
    from worker_ai.ai.transport import BUDGETED_CALL,post
    token=BUDGETED_CALL.set(True)
    try:
        with patch("worker_ai.ai.transport.httpx.post",return_value=NS(status_code=503)) as call:
            assert post("https://provider").status_code == 503
            call.assert_called_once()
    finally: BUDGETED_CALL.reset(token)


def test_reported_cache_costs_distinguish_base_read_and_write():
    # 100 ordinary + 200 reads + 200 5m writes + 100 1h writes.
    assert reported_cost("anthropic", "claude-sonnet-5", 600, 50, Decimal("2"), Decimal("10"), 200, 300, 100) == Decimal("0.00164")
    assert reported_cost("openai", "gpt-5.6-luna", 1000, 100, Decimal("0.2"), Decimal("1.2"), 200, 100) == Decimal("0.000289")
    with pytest.raises(ValueError): reported_cost("anthropic", "claude-sonnet-5", 100, 1, Decimal("2"), Decimal("10"), 101, 0)


def test_reservation_ceiling_refunds_unused_cache_price(database):
    d=database
    entry=request(d)
    assert entry.reserved_usd == token_cost(entry.input_bound,entry.output_cap,*rates("anthropic","claude-sonnet-5",ceiling=True))
    settle(d.db,entry,1000,100,usage_reported=True)
    assert d.db.get(Week,week_start()).billed_usd == Decimal("0.003")


def test_invalid_cache_breakdown_cannot_hide_known_token_cap_breach(database):
    d=database
    entry=request(d)
    output=entry.output_cap+1000
    settle(d.db,entry,100,output,usage_reported=True,cache_read=101)
    week=d.db.get(Week,week_start())
    assert week.unpriced_calls == 1
    assert week.billed_usd+week.reserved_usd >= token_cost(100,output,*rates("anthropic","claude-sonnet-5",ceiling=True))
    assert d.db.get(Reservation,entry.id).status == "unknown"
    with pytest.raises(AIBudgetStopped): request(d)


def test_completed_sunday_call_is_not_imported_again_when_monday_initializes_later(database):
    d = database
    sunday = datetime(2026, 9, 20, 23, 59, 58, tzinfo=timezone.utc)
    monday = sunday + timedelta(seconds=5)
    with patch("app.services.ai_budget.utcnow", return_value=sunday):
        previous = request(d)
    with patch("app.services.ai_budget.utcnow", return_value=monday):
        settle(d.db, previous, 1000, 100, usage_reported=True)
        d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5",
            input_tokens=1000, output_tokens=100, created_at=monday, reservation_id=previous.id))
        # Genuinely legacy usage must still be imported exactly once.
        d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5",
            input_tokens=100, output_tokens=10, created_at=monday))
        d.db.commit()
        current = request(d)
    assert d.db.get(Week, previous.week_start).billed_usd == Decimal("0.003")
    assert d.db.get(Week, current.week_start).billed_usd == Decimal("0.0005")


def test_proven_nonattempt_release_is_idempotent_and_never_releases_settled_cost(database):
    from app.services.ai_budget import release_unattempted
    d = database
    unused = request(d)
    release_unattempted(d.db, unused)
    release_unattempted(d.db, unused)
    assert d.db.get(Week, unused.week_start).reserved_usd == 0
    assert d.db.get(Reservation, unused.id).status == "released"
    used = request(d)
    settle(d.db, used, 1000, 100, usage_reported=True)
    release_unattempted(d.db, used)
    assert d.db.get(Week, used.week_start).billed_usd == Decimal("0.003")
    assert d.db.get(Reservation, used.id).status == "settled"


def test_unknown_cache_ttl_retains_unknown_metadata_with_conservative_cost(database):
    d = database
    entry = request(d)
    settle(d.db, entry, 1000, 100, usage_reported=True, cache_write=500, cache_write_1h=None)
    assert d.db.get(Reservation, entry.id).cache_write_1h_tokens is None
    assert d.db.get(Week, entry.week_start).billed_usd == Decimal("0.004")
    assert reported_cost("openai", "gpt-5.6-luna", 1000, 100, Decimal("0.2"), Decimal("1.2"), 800, None) == Decimal("0.000186")


def test_unknown_write_total_cannot_hide_reported_hour_writes():
    with pytest.raises(ValueError):
        reported_cost("openai", "gpt-5.6-luna", 1000, 100, Decimal("0.2"), Decimal("1.2"), 0, None, 500)


def test_administrator_limit_applies_to_the_next_request(database):
    first = request(database)
    assert first is not None
    database.db.add(AIBudgetSettings(id=1, limit_usd=Decimal("1.00"), updated_by="admin"))
    database.db.commit()
    with pytest.raises(AIBudgetStopped, match=r"limit \$1\.00"):
        for _ in range(50):
            request(database)
    row = database.db.get(Week, week_start())
    assert row.billed_usd + row.reserved_usd <= Decimal("1.00")
    status = view(week_start(), row.billed_usd, row.reserved_usd, limit=Decimal("1.00"))
    assert status["limit_usd"] == 1.0 and status["warning_usd"] == 0.8
    # Raising the limit mid-week clears the warning; it is not sticky.
    assert view(week_start(), Decimal("0.9"), warning_at=datetime.now(timezone.utc), limit=Decimal("50"))["warning"] is False
