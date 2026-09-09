from types import SimpleNamespace
from unittest.mock import patch

from worker_ai.ai.agent_state import set_agent_state


def _fake_agent(slug="linux"):
    return SimpleNamespace(
        slug=slug, status="idle", current_task=None, last_activity_at=None, error_message=None
    )


def _fake_db():
    return SimpleNamespace(commit=lambda: None)


def test_set_agent_state_updates_the_row_and_publishes():
    agent = _fake_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
        set_agent_state(_fake_db(), agent, "investigating", "get_disk_usage(ops-host)", "ops-host", "task-1")

    assert agent.status == "investigating"
    assert agent.current_task == "get_disk_usage(ops-host)"
    assert agent.error_message is None
    assert agent.last_activity_at is not None
    publish.assert_called_once_with("linux", "investigating", "get_disk_usage(ops-host)", "ops-host", "task-1")


def test_set_agent_state_error_sets_error_message():
    agent = _fake_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event"):
        set_agent_state(_fake_db(), agent, "error", "provider unavailable")

    assert agent.status == "error"
    assert agent.error_message == "provider unavailable"


def test_set_agent_state_clears_stale_error_message_on_recovery():
    agent = _fake_agent()
    agent.error_message = "old failure"
    with patch("worker_ai.ai.agent_state.publish_agent_event"):
        set_agent_state(_fake_db(), agent, "working", "Investigating: check disk")

    assert agent.error_message is None


def test_set_agent_state_truncates_long_activity():
    agent = _fake_agent()
    long_activity = "x" * 1000
    with patch("worker_ai.ai.agent_state.publish_agent_event"):
        set_agent_state(_fake_db(), agent, "working", long_activity)

    assert len(agent.current_task) == 500
