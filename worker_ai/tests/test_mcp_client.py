from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest
from worker_ai.ai.mcp_client import call_tool
from app.models.ai import AIAgent, AITask
from app.models.user import User
from app.models.mcp import MCPSettings


@pytest.mark.parametrize(
    "change",
    [
        "disabled_service",
        "disabled_agent",
        "removed_tool",
        "no_owner",
        "stopped_task",
        "schedule",
        "collaboration",
        "inactive_user",
        "no_grant",
    ],
)
def test_worker_cannot_issue_credentials_without_current_authority(change):
    agent = SimpleNamespace(id="agent", enabled=True, allowed_tools=["ops_list_hosts"])
    task = SimpleNamespace(
        id="task", owner_user_id="owner", status="running", source="web"
    )
    user = SimpleNamespace(id="owner", is_active=True)
    settings = SimpleNamespace(enabled=True)
    if change == "disabled_service":
        settings.enabled = False
    if change == "disabled_agent":
        agent.enabled = False
    if change == "removed_tool":
        agent.allowed_tools = []
    if change == "no_owner":
        task.owner_user_id = None
    if change == "stopped_task":
        task.status = "cancelled"
    if change in ("schedule", "collaboration"):
        task.source = change
    if change == "inactive_user":
        user.is_active = False
    db = Mock()
    db.get.side_effect = lambda model, ident: {
        AIAgent: agent,
        AITask: task,
        User: user,
        MCPSettings: settings,
    }[model]
    db.execute.return_value.scalars.return_value = []
    result = call_tool(db, agent, "task", "ops_list_hosts", {})
    assert "error" in result
    db.add.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize("authorized", [False, True])
def test_incident_mcp_rechecks_link_and_still_requires_existing_grant(authorized):
    agent = SimpleNamespace(id="agent", slug="linux", name="Linux", enabled=True, allowed_tools=["ops_list_hosts"])
    task = SimpleNamespace(id="task", owner_user_id="owner", status="running", source="incident")
    user = SimpleNamespace(id="owner", is_active=True)
    db = Mock()
    db.get.side_effect = lambda model, ident: {
        AIAgent: agent, AITask: task, User: user, MCPSettings: SimpleNamespace(enabled=True),
    }[model]
    db.execute.return_value.scalars.return_value = []
    db.execute.return_value.scalar.return_value = None
    with patch("worker_ai.ai.mcp_client.incident_task_authorized", return_value=authorized) as valid:
        result = call_tool(db, agent, "task", "ops_list_hosts", {})
    valid.assert_called_once_with(db, task)
    assert "error" in result
    assert ("Access required" in result["error"]) == authorized
    db.add.assert_not_called()
    db.commit.assert_not_called()


def test_mcp_is_lan_only():
    from unittest.mock import patch as p
    from worker_ai.ai.mcp_client import lan_only

    def resolving(*addresses):
        return lambda host, port: [(None, None, None, "", (a, 0)) for a in addresses]
    with p("worker_ai.ai.mcp_client.socket.getaddrinfo", resolving("198.51.100.46")):
        assert lan_only("https://ops.xn.example/mcp")
    with p("worker_ai.ai.mcp_client.socket.getaddrinfo", resolving("198.51.100.46", "104.21.10.249")):
        assert not lan_only("https://mixed.example/mcp")  # any public address refuses
    with p("worker_ai.ai.mcp_client.socket.getaddrinfo", resolving("2606:4700::1")):
        assert not lan_only("https://public.example/mcp")
    with p("worker_ai.ai.mcp_client.socket.getaddrinfo", side_effect=OSError("no such host")):
        assert not lan_only("https://unknown.example/mcp")
    assert not lan_only("") and not lan_only("not a url")
