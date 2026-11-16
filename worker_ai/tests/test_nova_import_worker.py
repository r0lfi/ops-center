"""Nova phase 4 in the worker: suggestions from the imported archive, and archive recall."""
import uuid
from types import SimpleNamespace as NS
from unittest.mock import MagicMock

import pytest
from sqlalchemy.dialects import postgresql

from app.core.memory_rules import KEY_RE
from app.services.ai_budget import AIBudgetStopped
from app.services.nova_import import BATCH_CHARS
from worker_ai.ai import import_suggestions as s
from worker_ai.ai.memory import recall
from worker_ai.ai.providers.base import ProviderResult


def sql(statement):
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def conv(title, size):
    return NS(title=title, transcript="x" * size, analyzed_at=None)


def test_batches_stay_within_the_character_budget():
    groups = list(s.batches([conv("a", 5000), conv("b", 5000), conv("c", 5000), conv("huge", BATCH_CHARS * 3)]))
    assert [[c.title for c, _ in g] for g in groups] == [["a", "b"], ["c"], ["huge"]]
    assert all(sum(len(p) for _, p in g) <= BATCH_CHARS + 20 for g in groups[:2])
    assert len(groups[2][0][1]) <= BATCH_CHARS + 20


def test_model_keys_are_prefixed_sanitized_and_secrets_dropped():
    rows = s.suggestion_rows(uuid.uuid4(), uuid.uuid4(), [
        {"key": "Morning Run!", "content": "Runs at 06:30"}, {"key": "x", "content": "token: aaaaaaaa"},
        {"content": "No key given"}, {"key": "empty", "content": " "}, "junk"][:4])
    assert [r["content"] for r in rows] == ["Runs at 06:30", "No key given"]
    assert all(r["key"].startswith("chatgpt.") and KEY_RE.fullmatch(r["key"]) and r["source"] == "import" for r in rows)


@pytest.fixture
def run_env(monkeypatch):
    owner = uuid.uuid4()
    agent = NS(id=uuid.uuid4(), slug="nova", enabled=True, personal=True, model=None, provider=NS(default_model="local"))
    pending = [conv("a", 5000), conv("b", 5000), conv("c", 5000)]
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = agent
    db.execute.return_value.scalar.return_value = True
    db.execute.return_value.scalars.return_value.all.side_effect = [pending] + [[uuid.uuid4()]] * 10
    db.scalar.return_value = 0
    provider = MagicMock()
    provider.chat.return_value = ProviderResult(text='{"suggestions": [{"key": "run", "content": "Runs at 06:30"}]}', tool_calls=[],
                                                stop_reason="stop", assistant_message={}, input_tokens=10, output_tokens=5, usage_reported=True)
    monkeypatch.setattr(s, "build_provider", lambda _: provider)
    monkeypatch.setattr(s, "memory_enabled", lambda *a: True)
    monkeypatch.setattr(s, "settle", MagicMock())
    import worker_ai.ai.runtime as r
    monkeypatch.setattr(r, "_record_usage", MagicMock())
    return NS(owner=owner, db=db, provider=provider, pending=pending)


def test_each_paid_batch_marks_only_its_conversations(run_env, monkeypatch):
    monkeypatch.setattr(s, "reserve", MagicMock(side_effect=[None, AIBudgetStopped("weekly limit")]))
    summary = s.run_import_suggestions(run_env.db, run_env.owner)
    assert summary["calls"] == 1 and summary["conversations"] == 2 and summary["stopped"] == "weekly limit"
    assert [c.analyzed_at is not None for c in run_env.pending] == [True, True, False]
    assert run_env.provider.chat.call_count == 1
    assert any("pg_advisory_unlock" in str(c.args[0]) for c in run_env.db.execute.call_args_list)


def test_memory_turned_off_stops_before_the_next_call(run_env, monkeypatch):
    monkeypatch.setattr(s, "reserve", MagicMock(return_value=None))
    state = iter([True, False])
    monkeypatch.setattr(s, "memory_enabled", lambda *a: next(state))
    assert s.run_import_suggestions(run_env.db, run_env.owner)["stopped"] == "memory disabled"
    run_env.provider.chat.assert_not_called()


def test_archive_recall_is_personal_agent_only():
    owner, agent = uuid.uuid4(), uuid.uuid4()
    db = MagicMock(); db.execute.return_value.scalars.return_value = []
    assert "imported_conversations" not in recall(db, owner, str(uuid.uuid4()), "coffee", agent)
    assert db.execute.call_count == 2
    db.reset_mock()
    result = recall(db, owner, str(uuid.uuid4()), "coffee", agent, personal=True)
    archive = sql(db.execute.call_args_list[2].args[0])
    assert result["imported_conversations"] == []
    assert f"ai_imported_conversations.user_id = '{owner}'" in archive and f"ai_imported_conversations.agent_id = '{agent}'" in archive
    assert "LIMIT 3" in archive and "coffee" in archive
