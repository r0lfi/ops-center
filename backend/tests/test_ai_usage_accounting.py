"""Usage API executes its real PostgreSQL aggregation against the ledger fixture."""
import asyncio
from decimal import Decimal
from app.api.routes.ai import usage_by_day
from app.models.ai import AIUsage
from app.models.ai_budget import AIBudgetReservation
from app.services.ai_budget import settle
from worker_ai.tests.test_weekly_budget import database, request


class AsyncRead:
    def __init__(self, db):
        self.db = db

    async def execute(self, statement):
        return self.db.execute(statement)


def test_usage_chart_uses_stored_cache_cost_after_model_price_changes(database):
    d = database
    entry = request(d)
    settle(d.db, entry, 1000, 100, usage_reported=True, cache_read=900)
    d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5",
        input_tokens=1000, output_tokens=100, reservation_id=entry.id))
    d.db.commit()
    from unittest.mock import patch
    with patch("app.api.routes.ai._estimate_cost", side_effect=AssertionError("Stored calls must not be repriced")):
        result = asyncio.run(usage_by_day(days=7, db=AsyncRead(d.db)))
    point = result["points"][0]
    assert point["cost_usd"] == float(Decimal("0.00138"))
    assert point["cost_basis"] == "stored" and point["calls"] == 1


def test_usage_chart_labels_legacy_mixture_and_unknown_outcomes(database):
    d = database
    entry = request(d)
    settle(d.db, entry, 1000, 100, usage_reported=True, cache_read=900)
    d.db.add_all([
        AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5", input_tokens=1000, output_tokens=100, reservation_id=entry.id),
        AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5", input_tokens=1000, output_tokens=100),
    ])
    d.db.commit()
    point = asyncio.run(usage_by_day(days=7, db=AsyncRead(d.db)))["points"][0]
    assert point["cost_usd"] == float(Decimal("0.00438")) and point["cost_basis"] == "mixed"
    assert point["estimated_calls"] == 1
    unknown = request(d)
    settle(d.db, unknown, 1000, 100, usage_reported=False)
    d.db.add(AIUsage(agent_id=d.agent.id, provider_id=d.provider.id, model="claude-sonnet-5", input_tokens=1000, output_tokens=100, reservation_id=unknown.id))
    d.db.commit()
    point = asyncio.run(usage_by_day(days=7, db=AsyncRead(d.db)))["points"][0]
    assert point["cost_usd"] is None and point["cost_basis"] == "unavailable" and point["unsettled_calls"] == 1


def test_migration_preserves_legacy_rows_and_guards_accounting_provenance(database):
    import importlib.util
    from pathlib import Path
    import uuid
    import pytest
    from sqlalchemy import text
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    migration_path = Path(__file__).parents[1] / "migrations/versions/0047_ai_usage_reservation.py"
    spec = importlib.util.spec_from_file_location("migration_0047_test", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    schema = "usage_migration_" + uuid.uuid4().hex
    with database.engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            connection.execute(text("CREATE TABLE ai_budget_reservations (id uuid PRIMARY KEY)"))
            connection.execute(text("CREATE TABLE ai_usage (id uuid PRIMARY KEY, input_tokens integer NOT NULL)"))
            legacy_id, reservation_id = uuid.uuid4(), uuid.uuid4()
            connection.execute(text("INSERT INTO ai_usage VALUES (:id, 123)"), {"id": legacy_id})
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                assert connection.execute(text("SELECT input_tokens,reservation_id FROM ai_usage")).one() == (123, None)
                connection.execute(text("INSERT INTO ai_budget_reservations VALUES (:id)"), {"id": reservation_id})
                connection.execute(text("UPDATE ai_usage SET reservation_id=:id"), {"id": reservation_id})
                with pytest.raises(RuntimeError, match="Preserve recorded usage"):
                    migration.downgrade()
                assert connection.execute(text("SELECT reservation_id FROM ai_usage")).scalar() == reservation_id
                connection.execute(text("UPDATE ai_usage SET reservation_id=NULL"))
                migration.downgrade()
                assert connection.execute(text("SELECT input_tokens FROM ai_usage")).scalar() == 123
        finally:
            transaction.rollback()
