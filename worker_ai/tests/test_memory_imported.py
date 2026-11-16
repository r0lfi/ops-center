"""Imported Claude memory (claude.* shared notes) and word-based recall."""
import uuid
from unittest.mock import MagicMock

from sqlalchemy.dialects import postgresql

from worker_ai.ai.memory import IMPORTED_KEY_PREFIX, note_context, recall, remember


def sql(statement):
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_imported_notes_do_not_take_automatic_context_slots():
    db = MagicMock(); owner = uuid.uuid4()
    db.execute.return_value.scalars.return_value = []
    db.scalar.return_value = 0
    note_context(db, owner)
    query = sql(db.execute.call_args.args[0])
    assert "ai_memories.key NOT LIKE 'claude.' || '%%'" in query
    assert "LIMIT 12" in query


def test_context_points_agents_to_imported_notes_when_present():
    db = MagicMock(); owner = uuid.uuid4()
    db.execute.return_value.scalars.return_value = []
    db.scalar.return_value = 240
    context = note_context(db, owner)
    assert "240 imported homelab knowledge notes" in context and "recall_memory" in context
    count_query = sql(db.scalar.call_args.args[0])
    assert str(owner) in count_query and "count(*)" in count_query.lower()
    db.scalar.return_value = 0
    assert "imported" not in note_context(db, owner)


def test_recall_requires_every_word_not_the_exact_phrase():
    db = MagicMock(); owner = uuid.uuid4()
    db.execute.return_value.scalars.return_value = []
    recall(db, owner, str(uuid.uuid4()), "docker-02  nextcloud")
    notes_query = sql(db.execute.call_args_list[1].args[0])
    assert "docker-02 nextcloud" not in notes_query
    for word in ("docker-02", "nextcloud"):
        assert f"(ai_memories.key ILIKE '%%' || '{word}' || '%%' ESCAPE '/')" in notes_query
    assert ") AND ((ai_memories.key ILIKE" in notes_query


def test_recall_word_count_is_bounded():
    db = MagicMock(); owner = uuid.uuid4()
    db.execute.return_value.scalars.return_value = []
    recall(db, owner, str(uuid.uuid4()), " ".join(f"w{i}" for i in range(20)))
    notes_query = sql(db.execute.call_args_list[1].args[0])
    assert "w7" in notes_query and "w8" not in notes_query


def test_models_cannot_write_reserved_import_keys():
    db = MagicMock(); owner = uuid.uuid4()
    for key in (f"{IMPORTED_KEY_PREFIX}homelab.01", "Claude.fake"):
        assert "reserved" in remember(db, owner, str(uuid.uuid4()), key, "overwrite attempt")["error"]
    db.execute.assert_not_called()
