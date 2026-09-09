from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from worker_ai.ai.runtime import TaskCancelled, _check_cancelled, run_agent
from worker_ai.tasks import _run_agent_task, execute_action_task


def test_cancelled_task_is_detected_from_database_not_cached_agent():
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = "cancelled"
    with pytest.raises(TaskCancelled):
        _check_cancelled(db, "task-id")


def test_running_or_untracked_task_can_continue():
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = "running"
    _check_cancelled(db, "task-id")
    db.reset_mock()
    _check_cancelled(db, None)
    db.execute.assert_not_called()


def test_stop_unwinds_agent_without_starting_provider():
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = "cancelled"
    agent = SimpleNamespace(enabled=True)
    with patch("worker_ai.ai.runtime._run_agent") as inner, patch("worker_ai.ai.runtime.set_agent_state") as state:
        with pytest.raises(TaskCancelled):
            run_agent(db, agent, "test", task_id="task-id")
        inner.assert_not_called()
        state.assert_called_once_with(db, agent, "idle", "Stopped by user", None, "task-id")


@pytest.mark.parametrize("status", ["cancelled", "completed", "running"])
def test_worker_does_not_start_cancelled_or_duplicate_delivery(status):
    db = MagicMock()
    db.execute.return_value.scalar_one_or_none.return_value = SimpleNamespace(status=status)
    with patch("worker_ai.tasks.SessionLocal") as session, patch("worker_ai.tasks.run_agent") as run:
        session.return_value.__enter__.return_value = db
        _run_agent_task("task-id", "celery-id")
        run.assert_not_called()


def test_approved_action_does_not_execute_after_task_cancelled():
    db = MagicMock()
    action = SimpleNamespace(status="approved", task_id="task-id")
    db.get.return_value = action
    db.execute.return_value.scalar_one_or_none.return_value = "cancelled"
    with patch("worker_ai.tasks.SessionLocal") as session, patch("worker_ai.tasks.EXECUTORS") as executors:
        session.return_value.__enter__.return_value = db
        execute_action_task("action-id")
        executors.__getitem__.assert_not_called()
    assert action.status == "expired"
