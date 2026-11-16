"""Memory suggestions are reviewed only by their owner and become notes only on accept."""
import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.api.routes.ai_memory import SuggestionDecision, accept_suggestion, list_suggestions, reject_suggestion
from app.core.memory_rules import JOURNAL_PREFIX

OWNER = SimpleNamespace(id=uuid.uuid4())
AGENT = uuid.uuid4()


def sql(statement):
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def db_with(row, *later):
    """The first execute finds `row`; later executes (target/existing lookups) find `later` in turn, else nothing."""
    db = AsyncMock()
    db.add = MagicMock()
    results = [row, *later]
    def execute(statement):
        found = results.pop(0) if results else None
        return MagicMock(scalar_one_or_none=lambda: found, scalars=lambda: [found] if found else [], all=lambda: [])
    db.execute.side_effect = execute
    return db


def suggestion(**overrides):
    values = dict(id=uuid.uuid4(), agent_id=AGENT, key="coffee", content="Drinks black coffee", source="conversation",
                  evidence_task_id=None, status="pending", created_at=None, decided_at=None, category=None, kind=None,
                  target_memory_id=None)
    return SimpleNamespace(**{**values, **overrides})


def test_lookup_is_owner_scoped_and_locked():
    db = db_with(None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(reject_suggestion(uuid.uuid4(), db, OWNER))
    assert error.value.status_code == 404
    query = sql(db.execute.call_args.args[0])
    assert f"ai_memory_suggestions.user_id = '{OWNER.id}'" in query and "FOR UPDATE" in query


def test_listing_is_owner_scoped():
    db = db_with(None)
    asyncio.run(list_suggestions("pending", 200, db, OWNER))
    query = sql(db.execute.call_args.args[0])
    assert f"user_id = '{OWNER.id}'" in query and "status = 'pending'" in query


def test_accept_writes_note_in_suggested_scope_and_records_decision():
    row = suggestion()
    db = db_with(row)
    asyncio.run(accept_suggestion(row.id, SuggestionDecision(content="Drinks black coffee at 7", category="Lifestyle"), db, OWNER))
    note = db.add.call_args.args[0]
    assert (note.agent_id, note.key, note.content, note.category) == (AGENT, "coffee", "Drinks black coffee at 7", "Lifestyle")
    assert row.status == "accepted" and row.decided_at is not None
    db.commit.assert_awaited_once()


def test_accepted_update_changes_the_target_and_keeps_its_previous_state():
    target = SimpleNamespace(id=uuid.uuid4(), user_id=OWNER.id, agent_id=None, key="career.employer", category="Career & Work",
                             kind=None, content="Works at Example AS", source_task_id=None, updated_at=None)
    row = suggestion(key="career.employer", content="Works at Sample ASA since 2026-10", target_memory_id=target.id)
    db = db_with(row, target)
    asyncio.run(accept_suggestion(row.id, SuggestionDecision(keep_history=True), db, OWNER))
    statements = [sql(c.args[0]) for c in db.execute.call_args_list[2:]]
    assert "INSERT INTO ai_memory_versions" in statements[0] and "Works at Example AS" in statements[0] and "'owner'" in statements[0]
    assert "INSERT INTO ai_memories" in statements[1] and "career.employer.history." in statements[1] and "'history'" in statements[1]
    assert target.content == "Works at Sample ASA since 2026-10" and target.agent_id is None and target.category == "Career & Work"
    db.add.assert_not_called()


def test_reject_never_writes_a_note():
    row = suggestion()
    db = db_with(row)
    asyncio.run(reject_suggestion(row.id, db, OWNER))
    assert row.status == "rejected" and db.execute.await_count == 1


@pytest.mark.parametrize("row,decision,status", [
    (suggestion(status="rejected"), None, 409),
    (suggestion(), SuggestionDecision(key=JOURNAL_PREFIX + "2026-10-25"), 422),
    (suggestion(), SuggestionDecision(key="bad key"), 422),
    (suggestion(), SuggestionDecision(content="password: aaaaaaaa"), 422),
])
def test_accept_refuses_decided_reserved_invalid_or_secret(row, decision, status):
    db = db_with(row)
    with pytest.raises(HTTPException) as error:
        asyncio.run(accept_suggestion(row.id, decision, db, OWNER))
    assert error.value.status_code == status
    assert db.execute.await_count == 1 and row.status == ("rejected" if status == 409 else "pending")


def test_imported_suggestion_keeps_its_own_reserved_prefix():
    row = suggestion(key="chatgpt.coffee", source="import")
    db = db_with(row)
    asyncio.run(accept_suggestion(row.id, None, db, OWNER))
    assert row.status == "accepted"
    with pytest.raises(HTTPException):
        asyncio.run(accept_suggestion(suggestion(key="chatgpt.x").id, SuggestionDecision(key="gemini.x"), db_with(suggestion(key="chatgpt.x")), OWNER))
