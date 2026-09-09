from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from worker_ai.ai.actions import request_approval


def _fake_agent():
    return SimpleNamespace(id="agent-1", slug="linux")


def _fake_db():
    db = MagicMock()
    db.execute.return_value.scalars.return_value.first.return_value = None  # no existing matching action
    db.execute.return_value.scalar_one_or_none.return_value = None  # no host row needed for these assertions
    return db


def test_request_approval_creates_a_pending_row_and_never_executes_anything():
    db = _fake_db()
    with patch("worker_ai.ai.actions.set_agent_state") as set_state:
        result = request_approval(
            db, _fake_agent(), "restart_service", {"hostname": "example-web-01", "service": "nginx"}, "task-1", "because"
        )

    assert result["status"] == "pending_approval"
    assert result["request_code"].startswith("ACT-")
    assert "nginx" in result["action"]

    db.add.assert_called_once()
    action = db.add.call_args[0][0]
    assert action.status == "pending"
    assert action.tool == "restart_service"
    assert action.approval_level == 2
    assert action.arguments == {"hostname": "example-web-01", "service": "nginx"}
    db.commit.assert_called()
    set_state.assert_called_once()  # agent flips to "waiting" - see agent_state.set_agent_state


def test_reboot_host_is_level_three_and_high_risk():
    db = _fake_db()
    with patch("worker_ai.ai.actions.set_agent_state"):
        request_approval(db, _fake_agent(), "reboot_host", {"hostname": "example-web-01"}, None, "because")

    action = db.add.call_args[0][0]
    assert action.approval_level == 3
    assert action.risk == "high"


def test_request_codes_are_unique_per_call():
    db = _fake_db()
    with patch("worker_ai.ai.actions.set_agent_state"):
        first = request_approval(db, _fake_agent(), "restart_service", {"hostname": "a", "service": "nginx"}, None, "x")
        second = request_approval(db, _fake_agent(), "restart_service", {"hostname": "a", "service": "nginx"}, None, "x")

    assert first["request_code"] != second["request_code"]
