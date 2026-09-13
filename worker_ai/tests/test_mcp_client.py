from types import SimpleNamespace
from unittest.mock import Mock
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
