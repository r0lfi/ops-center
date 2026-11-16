"""Nova phase 2: memory suggestions, owner profile and the nightly journal."""
import uuid
from datetime import date, datetime, timezone
from types import SimpleNamespace as NS
from unittest.mock import MagicMock

import pytest
from sqlalchemy.dialects import postgresql

from app.core.memory_rules import JOURNAL_PREFIX
from app.models.ai_memory import AIMemoryPreference
from app.models.user import User
from app.services.ai_budget import AIBudgetStopped
from worker_ai.ai import journal as j
from worker_ai.ai import runtime as r
from worker_ai.ai.memory import PROFILE_LIMIT, note_context, remember, suggest
from worker_ai.ai.providers.base import ProviderResult


def sql(statement):
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_suggestions_are_validated_before_any_write():
    db = MagicMock(); owner = uuid.uuid4(); task = str(uuid.uuid4()); agent = uuid.uuid4()
    assert "error" in suggest(db, None, task, "k", "likes tea", agent_id=agent)
    for key, content in [("bad key", "x"), ("ok", ""), ("ok", "x" * 2001), ("ok", "api_key = abc"),
                         (f"{JOURNAL_PREFIX}2026-10-25", "fake journal"), ("chatgpt.fake", "fake import")]:
        assert "error" in suggest(db, owner, task, key, content, agent_id=agent)
    db.execute.assert_not_called()


def test_suggestion_is_insert_or_nothing_on_the_content_hash():
    db = MagicMock(); owner = uuid.uuid4(); agent = uuid.uuid4()
    db.scalar.return_value = 0
    db.execute.return_value.scalars.return_value.all.return_value = [uuid.uuid4()]
    assert suggest(db, owner, str(uuid.uuid4()), "morning_coffee", "Drinks black coffee at 7", agent_id=agent)["suggested"]
    statement = sql(db.execute.call_args.args[0])
    assert "ON CONFLICT ON CONSTRAINT uq_ai_memory_suggestion_hash DO NOTHING" in statement
    assert "'pending'" in statement and "'conversation'" in statement and str(owner) in statement
    db.execute.return_value.scalars.return_value.all.return_value = []
    result = suggest(db, owner, str(uuid.uuid4()), "coffee", "drinks  BLACK coffee at 7", agent_id=agent)
    assert result == {"suggested": False, "reason": "Already suggested earlier (pending, accepted or rejected)."}


def test_known_note_is_not_suggested_again():
    db = MagicMock(); db.scalar.return_value = 1
    assert not suggest(db, uuid.uuid4(), str(uuid.uuid4()), "k", "Likes tea", agent_id=uuid.uuid4())["suggested"]
    db.execute.assert_not_called()


def test_models_cannot_write_journal_or_import_keys():
    db = MagicMock()
    for key in (f"{JOURNAL_PREFIX}2026-10-25", "chatgpt.x", "gemini.x", "claudeai.x", "imported.x"):
        assert "reserved" in remember(db, uuid.uuid4(), str(uuid.uuid4()), key, "x")["error"]
    db.execute.assert_not_called()


def test_personal_context_has_shared_slots_and_a_bounded_profile():
    owner, agent = uuid.uuid4(), uuid.uuid4()
    notes = [NS(key=f"note_{i:02d}", content="x" * 500, agent_id=agent) for i in range(10)]
    db = MagicMock()
    db.execute.return_value.scalars.side_effect = [[], notes]
    db.scalar.side_effect = [3, 0]  # profile journal count, then imported claude.* count
    context = note_context(db, owner, agent, personal=True)
    slots, profile, index = (sql(c.args[0]) for c in db.execute.call_args_list)
    assert "ai_memories.category, ai_memories.key" in index and "NOT LIKE" in index
    assert "ai_memories.agent_id IS NULL" in slots and str(agent) not in slots and "LIMIT 12" in slots
    assert f"ai_memories.agent_id = '{agent}'" in profile and "nova.journal." in profile and "NOT LIKE" in profile
    profile_text = context.split("Owner profile")[1]
    assert len(profile_text) < PROFILE_LIMIT + 300 and "more notes: search with recall_memory" in profile_text
    assert "3 journal notes" in context


def test_non_personal_context_is_unchanged():
    db = MagicMock(); db.execute.return_value.scalars.return_value = []; db.scalar.return_value = 0
    assert "Owner profile" not in note_context(db, uuid.uuid4(), uuid.uuid4())
    assert db.execute.call_count == 1


@pytest.mark.parametrize("personal", [True, False])
def test_only_personal_agents_get_suggest_memory(monkeypatch, personal):
    agent = NS(id=uuid.uuid4(), slug="a", name="A", enabled=True, runtime="native", personal=personal,
               provider=NS(enabled=True, kind="ollama", default_model="m"), model="m", provider_id=uuid.uuid4(),
               allowed_tools=["web_search"], allowed_hosts=[], allowed_environments=[], allowed_dispatch_targets=None,
               system_prompt="", max_tool_calls=4, max_execution_seconds=30)
    provider = MagicMock()
    provider.chat.return_value = ProviderResult(text="ok", tool_calls=[], stop_reason="stop", assistant_message={"role": "assistant", "content": "ok"})
    db = MagicMock(); db.get.return_value = None; db.execute.return_value.scalar_one_or_none.return_value = "running"
    for name, value in {"build_provider": lambda _: provider, "memory_owner": lambda *a: uuid.uuid4(),
                        "note_context": lambda *a, **k: "", "set_agent_state": MagicMock(),
                        "reserve_usd": MagicMock(return_value=None), "settle_usd": MagicMock(), "_record_usage": MagicMock()}.items():
        monkeypatch.setattr(r, name, value)
    r.run_agent(db, agent, "hei")
    kwargs = provider.chat.call_args.kwargs
    assert ("suggest_memory" in {t["name"] for t in kwargs["tools"]}) is personal
    assert ("personal agent" in kwargs["system"]) is personal


def test_journal_output_parsing_and_bounds():
    assert j.parse_output('noise {"journal": "Dag", "suggestions": [{"key": "a", "content": "b"}, 3]} tail') == ("Dag", [{"key": "a", "content": "b"}])
    assert j.parse_output("plain text") == ("plain text", [])
    assert j.parse_output('{"journal": 5}') == ("", [])
    tasks = [NS(created_at=datetime(2026, 10, 25, 8, tzinfo=timezone.utc), input_message="q" * 5000, response_message=None)] * 30
    transcript = j.build_transcript(tasks)
    assert transcript.count("Owner:") == j.MAX_EXCHANGES and "q" * (j.EXCHANGE_CHARS + 1) not in transcript
    assert j.without_secrets("ok\npassword: x\nfine") == "ok\nfine"


class JournalDB:
    """Just enough session for journal_for: users, preferences, scalar counts and statements."""
    def __init__(self, enabled=True, existing=0, locked=True):
        self.enabled, self.existing, self.locked = enabled, existing, locked
        self.statements, self.commits = [], 0

    def get(self, model, key):
        if model is User: return NS(is_active=True)
        if model is AIMemoryPreference: return NS(enabled=self.enabled)

    def scalar(self, statement):
        text = sql(statement)
        return self.existing if "nova.journal.2026-10-24" in text else 0

    def execute(self, statement, params=None):
        text = str(statement)
        self.statements.append(sql(statement) if not params else text)
        if "pg_try_advisory_lock" in text:
            return NS(scalar=lambda: self.locked)
        return NS(scalars=lambda: NS(all=lambda: [uuid.uuid4()]))

    def commit(self): self.commits += 1
    def expire_all(self): pass
    def rollback(self): pass


@pytest.fixture
def journal_env(monkeypatch):
    owner = uuid.uuid4()
    agent = NS(id=uuid.uuid4(), slug="nova", model=None, provider=NS(default_model="local", kind="openai_compatible"))
    tasks = [NS(id=uuid.uuid4(), created_at=datetime(2026, 10, 24, 9, tzinfo=timezone.utc), input_message="Jeg drikker kaffe svart", response_message="Notert")]
    provider = MagicMock()
    provider.chat.return_value = ProviderResult(
        text='{"journal": "Snakket om kaffe.\\ntoken: abc", "suggestions": [{"key": "coffee", "content": "Drikker kaffe svart"}, {"key": "bad key", "content": "x"}]}',
        tool_calls=[], stop_reason="stop", assistant_message={}, input_tokens=100, output_tokens=40, usage_reported=True)
    monkeypatch.setattr(j, "_owner_tasks", lambda *a: tasks)
    monkeypatch.setattr(j, "build_provider", lambda _: provider)
    monkeypatch.setattr(j, "reserve", MagicMock(return_value=None))
    monkeypatch.setattr(j, "settle", MagicMock())
    monkeypatch.setattr(r, "_record_usage", MagicMock())
    return NS(owner=owner, agent=agent, provider=provider, day=date(2026, 10, 24))


def test_journal_writes_note_and_suggestions_without_secrets(journal_env):
    db = JournalDB()
    assert j.journal_for(db, journal_env.agent, journal_env.owner, journal_env.day) == "written, 1 suggestions"
    note = next(s for s in db.statements if "INSERT INTO ai_memories" in s)
    assert "nova.journal.2026-10-24" in note and "Snakket om kaffe." in note and "abc" not in note
    assert "ON CONFLICT ON CONSTRAINT uq_ai_memory_user_key DO NOTHING" in note
    suggestion = next(s for s in db.statements if "INSERT INTO ai_memory_suggestions" in s)
    assert "'journal'" in suggestion and "Drikker kaffe svart" in suggestion and "bad key" not in suggestion
    assert any("pg_advisory_unlock" in s for s in db.statements)


@pytest.mark.parametrize("db,outcome", [(JournalDB(enabled=False), "memory disabled"),
                                         (JournalDB(existing=1), "already written"),
                                         (JournalDB(locked=False), "locked by another run")])
def test_journal_skips_without_a_model_call(journal_env, db, outcome):
    assert j.journal_for(db, journal_env.agent, journal_env.owner, journal_env.day) == outcome
    journal_env.provider.chat.assert_not_called()
    assert not any("INSERT" in s for s in db.statements)


def test_journal_without_conversations_makes_no_call(journal_env, monkeypatch):
    monkeypatch.setattr(j, "_owner_tasks", lambda *a: [])
    assert j.journal_for(JournalDB(), journal_env.agent, journal_env.owner, journal_env.day) == "no conversations"
    journal_env.provider.chat.assert_not_called()


def test_budget_stop_skips_the_owner(journal_env, monkeypatch):
    monkeypatch.setattr(j, "reserve", MagicMock(side_effect=AIBudgetStopped("limit")))
    db = MagicMock()
    db.execute.return_value.scalars.return_value.all.side_effect = [[NS(id=uuid.uuid4(), slug="nova", provider=journal_env.agent.provider)], [journal_env.owner]]
    monkeypatch.setattr(j, "journal_for", MagicMock(side_effect=AIBudgetStopped("limit")))
    assert j.run_journal(db, journal_env.day) == {f"nova:{journal_env.owner}": "skipped: AIBudgetStopped"}
    db.rollback.assert_called_once()


def test_an_agent_overwriting_a_note_keeps_its_previous_state():
    from app.models.ai_memory import AIMemory
    owner = uuid.uuid4()
    existing = AIMemory(id=uuid.uuid4(), user_id=owner, agent_id=None, key="employer", content="Example AS", category="Career & Work", kind=None)
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = existing
    assert remember(db, owner, str(uuid.uuid4()), "employer", "Sample ASA", category="Career & Work")["saved"]
    statements = [sql(c.args[0]) for c in db.execute.call_args_list[1:]]
    assert "INSERT INTO ai_memory_versions" in statements[0] and "'Example AS'" in statements[0] and "'agent'" in statements[0]
    assert "ON CONFLICT ON CONSTRAINT uq_ai_memory_user_key DO UPDATE" in statements[1]
    db.reset_mock()
    db.execute.return_value.scalar_one_or_none.return_value = existing
    remember(db, owner, str(uuid.uuid4()), "employer", "Example AS")
    assert not any("ai_memory_versions" in sql(c.args[0]) for c in db.execute.call_args_list[1:])


def test_update_suggestion_needs_an_existing_visible_note():
    db = MagicMock(); db.execute.return_value.scalars.return_value.all.return_value = []
    result = suggest(db, uuid.uuid4(), str(uuid.uuid4()), "career.title", "Principal", agent_id=uuid.uuid4(), replaces_key="career.title")
    assert "No note with key" in result["error"]
