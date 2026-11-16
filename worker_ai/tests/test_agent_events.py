from worker_ai.ai.agent_state import _default_event, public_error


def test_error_text_keeps_cause_but_drops_paths_and_credentials():
    text = public_error("[Errno 2] No such file or directory: '/app/secrets/ai-providers/mistral.key' key sk-abcdef1234567890XYZ")
    assert "No such file or directory" in text
    assert "/app/secrets" not in text and "mistral.key" not in text and "sk-abcdef" not in text


def test_urls_are_not_mangled_into_paths():
    assert public_error("Mistral API call failed: 401 for https://api.mistral.ai/v1/chat/completions") \
        == "Mistral API call failed: 401 for https://api.mistral.ai/v1/chat/completions"


def test_default_events_follow_status():
    assert _default_event("error", "x") == "error"
    assert _default_event("idle", None) == "completed"
    assert _default_event("idle", "Weekly budget reached") == "stopped"
    assert _default_event("working", "x") is None


def test_personal_work_publishes_the_event_but_not_the_tool():
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch
    from worker_ai.ai.agent_state import set_agent_state
    db = MagicMock()
    db.get.return_value = None
    agent = SimpleNamespace(slug="nova", personal=True, status="idle", current_task=None, last_activity_at=None, error_message=None)
    with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
        set_agent_state(db, agent, "investigating", "web_search(secret plans)", "host", "task-1", event="tool_started", tool="web_search")
    publish.assert_called_once_with("nova", "investigating", "Personal conversation", None, None, event="tool_started", peer=None, tool=None)
