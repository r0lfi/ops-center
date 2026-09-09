import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock
from types import SimpleNamespace
from sqlalchemy.dialects import postgresql
from app.models.ai import AITask
from app.models.ai_memory import AIMemoryPreference
from app.models.user import User
from worker_ai.ai.memory import memory_owner, recall, remember, note_context
from worker_ai.tasks import _build_contextual_message


def sql(statement):
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def test_owner_comes_from_task_not_username_or_model():
    owner = uuid.uuid4(); task_id = uuid.uuid4()
    task = AITask(id=task_id, source="web", owner_user_id=owner)
    user = User(id=owner, is_active=True)
    db = MagicMock(); db.get.side_effect = [task, user, None]
    assert memory_owner(db, str(task_id)) == owner
    db.get.side_effect = [task, user, AIMemoryPreference(user_id=owner, enabled=False)]
    assert memory_owner(db, str(task_id)) is None
    task.source = "nextcloud_talk"; db.get.side_effect = [task]
    assert memory_owner(db, str(task_id)) is None


def test_recall_scopes_both_archive_and_notes_and_escapes_wildcards():
    owner = uuid.uuid4(); task_id = uuid.uuid4()
    db = MagicMock(); db.execute.return_value.scalars.return_value = []
    recall(db, owner, str(task_id), "50%_load")
    statements = [sql(c.args[0]) for c in db.execute.call_args_list]
    assert str(owner) in statements[0] and str(owner) in statements[1]
    assert "owner_user_id" in statements[0] and "source IN ('web', 'talk')" in statements[0]
    assert "LIMIT 4" in statements[0] and "LIMIT 8" in statements[1]
    assert "ESCAPE '/'" in statements[0]


def test_disabled_memory_neither_reads_nor_writes():
    db = MagicMock()
    assert "error" in recall(db, None, str(uuid.uuid4()), "test")
    assert "error" in remember(db, None, str(uuid.uuid4()), "name", "name")
    assert note_context(db, None) == ""
    db.execute.assert_not_called()


def test_reject_invalid_notes_and_credentials():
    db = MagicMock(); owner = uuid.uuid4(); task_id = str(uuid.uuid4())
    for key, content in [("bad key", "test"), ("good", " " ), ("good", "x"*2001), ("good", "password=secret"), ("good", "-----BEGIN OPENSSH PRIVATE KEY")]:
        assert "error" in remember(db, owner, task_id, key, content)
    db.execute.assert_not_called()


def test_save_is_owner_scoped_upsert():
    db = MagicMock(); owner = uuid.uuid4(); task_id = str(uuid.uuid4())
    assert remember(db, owner, task_id, "preferred_language", "Norwegian")["saved"]
    query = sql(db.execute.call_args.args[0])
    assert str(owner) in query and "ON CONFLICT ON CONSTRAINT uq_ai_memory_user_key" in query
    db.commit.assert_called_once()


def test_missing_trusted_task_cannot_load_history():
    db = MagicMock()
    assert _build_contextual_message(db, "someone-elses-key", "hello") == "hello"
    db.execute.assert_not_called()


def test_short_history_scoped_even_if_conversation_key_is_guessed():
    from unittest.mock import patch
    owner = uuid.uuid4()
    task = AITask(id=uuid.uuid4(), owner_user_id=owner, agent_id=uuid.uuid4(), source="web", created_at=datetime.now(timezone.utc))
    db = MagicMock(); db.execute.return_value.all.return_value = []
    with patch("worker_ai.tasks.memory_owner", return_value=None):
        _build_contextual_message(db, "guessed-key", "hello", task)
    query = sql(db.execute.call_args.args[0])
    assert str(owner) in query and "guessed-key" in query and "source = 'web'" in query


def test_outputs_are_bounded():
    db = MagicMock(); row = SimpleNamespace(id=uuid.uuid4(),created_at=datetime.now(timezone.utc),input_message="a"*10000,response_message="b"*10000)
    tasks = MagicMock(); tasks.scalars.return_value = [row]
    notes = MagicMock(); notes.scalars.return_value = []
    db.execute.side_effect = [tasks, notes]
    value = recall(db, uuid.uuid4(), str(uuid.uuid4()), "")
    assert len(value["conversations"][0]["user"]) == 1500
    assert len(value["conversations"][0]["assistant"]) == 1500


def test_agent_reads_only_shared_and_its_own_notes():
    owner, agent_id, task_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    db = MagicMock(); db.execute.return_value.scalars.return_value = []
    note_context(db, owner, agent_id)
    query = sql(db.execute.call_args.args[0])
    assert str(owner) in query and str(agent_id) in query
    assert 'ai_memories.agent_id IS NULL OR ai_memories.agent_id =' in query
    db.reset_mock()
    recall(db, owner, str(task_id), '', agent_id)
    query = sql(db.execute.call_args_list[1].args[0])
    assert str(owner) in query and str(agent_id) in query
    assert 'ai_memories.agent_id IS NULL OR ai_memories.agent_id =' in query


def test_without_agent_context_only_shared_notes_are_visible():
    db = MagicMock(); db.execute.return_value.scalars.return_value = []
    note_context(db, uuid.uuid4())
    query = sql(db.execute.call_args.args[0])
    assert 'ai_memories.agent_id IS NULL' in query
    assert ' OR ' not in query


def test_remember_agent_scope_uses_trusted_runtime_agent():
    db = MagicMock(); agent_id = uuid.uuid4()
    result = remember(db, uuid.uuid4(), str(uuid.uuid4()), 'routine', 'Container routines', agent_id=agent_id, scope='agent')
    assert result['scope'] == 'agent'
    assert str(agent_id) in sql(db.execute.call_args.args[0])
    db.reset_mock()
    result = remember(db, uuid.uuid4(), str(uuid.uuid4()), 'routine', 'Shared routines', agent_id=agent_id, scope='shared')
    assert result['scope'] == 'shared'
    assert str(agent_id) not in sql(db.execute.call_args.args[0])


def test_invalid_scope_cannot_create_or_promote_agent_notes():
    db = MagicMock()
    for scope in ['someone_else', None, 'agent']:
        assert 'error' in remember(db, uuid.uuid4(), str(uuid.uuid4()), 'routine', 'test', scope=scope)
    db.execute.assert_not_called()


def test_talk_owner_requires_current_binding():
    from unittest.mock import patch
    owner = uuid.uuid4(); task_id = uuid.uuid4()
    task = AITask(id=task_id, source="talk", owner_user_id=owner,
                  requested_by="talk:users/example-user", conversation_key="talk:private")
    user = User(id=owner, is_active=True)
    db = MagicMock(); db.get.side_effect = [task, user, None]
    with patch("worker_ai.ai.memory.task_binding_valid", return_value=True):
        assert memory_owner(db, str(task_id)) == owner
    db.get.side_effect = [task]
    with patch("worker_ai.ai.memory.task_binding_valid", return_value=False):
        assert memory_owner(db, str(task_id)) is None


def test_talk_history_uses_actual_source_and_isolates_owners():
    from unittest.mock import patch
    owner = uuid.uuid4()
    task = AITask(id=uuid.uuid4(), owner_user_id=owner, source="talk",
                  created_at=datetime.now(timezone.utc))
    db = MagicMock(); db.execute.return_value.all.return_value = []
    with patch("worker_ai.tasks.memory_owner", return_value=owner):
        _build_contextual_message(db, "talk:private", "hello", task)
    query = sql(db.execute.call_args.args[0])
    assert "source = 'talk'" in query and str(owner) in query and "talk:private" in query
    db.reset_mock(); task.owner_user_id = None
    _build_contextual_message(db, "talk:private", "hello", task)
    assert 'owner_user_id IS NULL' in sql(db.execute.call_args.args[0])
