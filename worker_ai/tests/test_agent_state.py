from types import SimpleNamespace
from unittest.mock import patch

from worker_ai.ai.agent_state import set_agent_state


def _fake_agent(slug="linux"):
    return SimpleNamespace(
        slug=slug, status="idle", current_task=None, last_activity_at=None, error_message=None
    )


def _fake_db():
    return SimpleNamespace(commit=lambda: None, get=lambda *args: None)


def test_set_agent_state_updates_the_row_and_publishes():
    agent = _fake_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
        set_agent_state(_fake_db(), agent, "investigating", "get_disk_usage(ops-host)", "ops-host", "task-1")

    assert agent.status == "investigating"
    assert agent.current_task == "get_disk_usage(ops-host)"
    assert agent.error_message is None
    assert agent.last_activity_at is not None
    publish.assert_called_once_with("linux", "investigating", "get_disk_usage(ops-host)", "ops-host", "task-1", event=None, peer=None, tool=None)


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


def test_incident_activity_keeps_owner_memory_out_of_shared_stream():
    from app.models.ai import AITask
    task = AITask(source="incident")
    db = SimpleNamespace(commit=lambda: None, get=lambda *args: task)
    agent = _fake_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
        set_agent_state(db, agent, "working", "Private troubleshooting detail", "private-host", "task")
    assert agent.current_task == "Incident investigation"
    publish.assert_called_once_with("linux", "working", "Incident investigation", None, None, event=None, peer=None, tool=None)


def _real_agent(slug="developer"):
    import uuid
    from app.models.ai import AIAgent
    return AIAgent(id=uuid.uuid4(), slug=slug, name=slug, enabled=True, status="working", max_execution_seconds=900)


def _db_with_running(n):
    row = SimpleNamespace(running=n, queued=0)
    return SimpleNamespace(commit=lambda: None, get=lambda *args: None,
                           execute=lambda query: SimpleNamespace(first=lambda: row if n else None))


def test_finishing_one_of_several_tasks_keeps_the_agent_working():
    agent = _real_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
        set_agent_state(_db_with_running(11), agent, "idle", None, None, "00000000-0000-0000-0000-000000000001")
    assert agent.status == "working" and agent.current_task == "11 more tasks running"
    # The event still says this task completed.
    assert publish.call_args.kwargs["event"] == "completed" and publish.call_args.args[1] == "working"


def test_finishing_the_last_task_makes_the_agent_idle():
    agent = _real_agent()
    with patch("worker_ai.ai.agent_state.publish_agent_event"):
        set_agent_state(_db_with_running(0), agent, "idle", None, None, "00000000-0000-0000-0000-000000000001")
    assert agent.status == "idle" and agent.current_task is None
