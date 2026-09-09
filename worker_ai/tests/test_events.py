import json
from unittest.mock import MagicMock, patch

from worker_ai.events import CHANNEL, publish_agent_event


def test_publish_agent_event_publishes_expected_shape():
    fake_client = MagicMock()
    with patch("worker_ai.events.get_redis_client", return_value=fake_client):
        publish_agent_event("linux", "investigating", "get_disk_usage(ops-host)", "ops-host", "task-1")

    fake_client.publish.assert_called_once()
    channel, payload = fake_client.publish.call_args[0]
    assert channel == CHANNEL
    data = json.loads(payload)
    assert data["agent"] == "linux"
    assert data["status"] == "investigating"
    assert data["target"] == "ops-host"
    assert data["task_id"] == "task-1"
    assert "ts" in data


def test_publish_agent_event_never_raises_when_redis_is_unavailable():
    with patch("worker_ai.events.get_redis_client", side_effect=RuntimeError("redis down")):
        publish_agent_event("linux", "idle", None, None, None)  # must not raise
