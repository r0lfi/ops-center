from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.exc import ProgrammingError

from worker_ai.ai.runtime import run_agent
from worker_ai.tasks import _run_agent_task


def test_database_failure_rolls_back_before_marking_task_failed():
    db = MagicMock()
    agent = SimpleNamespace(enabled=True)
    task = SimpleNamespace(id="task-id", status="queued", agent=agent,
                           conversation_key=None, input_message="request approval",
                           started_at=None, created_at=datetime.now(timezone.utc))
    db.execute.return_value.scalar_one_or_none.return_value = task
    aborted = False

    def fail(*args, **kwargs):
        nonlocal aborted
        aborted = True
        raise ProgrammingError("SELECT missing_column", {}, Exception("missing column"))

    def rollback():
        nonlocal aborted
        aborted = False

    def require_transaction(*args, **kwargs):
        assert not aborted, "attempted SQL on an aborted transaction"

    db.rollback.side_effect = rollback
    db.refresh.side_effect = require_transaction
    db.commit.side_effect = require_transaction
    with patch("worker_ai.tasks.SessionLocal") as factory, \
         patch("worker_ai.tasks._build_contextual_message", return_value="request approval"), \
         patch("worker_ai.tasks.run_agent", side_effect=fail), \
         patch("worker_ai.tasks.set_agent_state"):
        factory.return_value.__enter__.return_value = db
        _run_agent_task("task-id", "celery-id")
    assert task.status == "failed"
    assert task.completed_at is not None
    assert "missing column" in task.error_message
    db.rollback.assert_called_once()


def test_delegated_agent_database_failure_unwinds_its_visible_state():
    db = MagicMock()
    agent = SimpleNamespace(enabled=True)
    failure = ProgrammingError("SELECT missing_column", {}, Exception("missing column"))
    with patch("worker_ai.ai.runtime._check_cancelled"), \
         patch("worker_ai.ai.runtime._run_agent", side_effect=failure), \
         patch("worker_ai.ai.runtime.set_agent_state") as state:
        state.side_effect = lambda *args: db.rollback.assert_called_once()
        with pytest.raises(ProgrammingError):
            run_agent(db, agent, "request approval", task_id="task-id", depth=1)
    assert state.call_args.args[2] == "error"
