from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch
import time
import httpx
import pytest
from worker_ai.ai.transport import post, DEADLINE
from worker_ai.ai.runtime import run_agent, TaskBudgetExceeded
from worker_ai.ai.providers.base import ProviderResult, ToolCall
from worker_ai.tasks import execute_action_task


def test_provider_retries_explicit_503_once_and_obeys_budget():
    token = DEADLINE.set(time.monotonic() + 10)
    try:
        with patch(
            "worker_ai.ai.transport.httpx.post",
            side_effect=[NS(status_code=503), NS(status_code=200)],
        ) as call, patch("worker_ai.ai.transport.time.sleep"):
            assert post("https://provider", timeout=60).status_code == 200
            assert call.call_count == 2
            assert 0 < call.call_args.kwargs["timeout"] <= 10
    finally:
        DEADLINE.reset(token)


def test_uncertain_provider_timeout_is_not_retried():
    with patch(
        "worker_ai.ai.transport.httpx.post", side_effect=httpx.ReadTimeout("uncertain")
    ) as call:
        with pytest.raises(httpx.ReadTimeout):
            post("https://provider")
        call.assert_called_once()


def test_tool_budget_rejects_batch_before_dispatch():
    db = MagicMock()
    db.get.return_value = None
    db.execute.return_value.scalar_one_or_none.return_value = None
    agent = NS(
        enabled=True,
        max_execution_seconds=10,
        max_tool_calls=1,
        provider=NS(default_model="test"),
        model=None,
        allowed_tools=["get_alerts"],
        system_prompt="",
        id="a",
        slug="monitoring",
        allowed_hosts=[],
        allowed_environments=[],
    )
    provider = MagicMock()
    provider.chat.return_value = ProviderResult(
        text="",
        stop_reason="tool_use",
        tool_calls=[
            ToolCall(id="1", name="get_alerts", arguments={}),
            ToolCall(id="2", name="get_alerts", arguments={}),
        ],
    )
    with patch("worker_ai.ai.runtime.build_provider", return_value=provider), patch(
        "worker_ai.ai.runtime.memory_owner", return_value=None
    ), patch("worker_ai.ai.runtime.note_context", return_value=""), patch(
        "worker_ai.ai.runtime.set_agent_state"
    ), patch(
        "worker_ai.ai.runtime._record_usage"
    ), patch(
        "worker_ai.ai.runtime._safe_read"
    ) as read:
        with pytest.raises(TaskBudgetExceeded):
            run_agent(db, agent, "status")
        read.assert_not_called()


def test_worker_claims_once_before_state_commit_and_rechecks_authority():
    now = datetime.now(timezone.utc)
    agent = NS(
        enabled=True,
        allowed_tools=["restart_service"],
        allowed_hosts=[],
        allowed_environments=[],
    )
    a = NS(
        status="approved",
        task_id=None,
        approved_by="owner",
        approval_level=2,
        expires_at=now + timedelta(minutes=5),
        agent=agent,
        tool="restart_service",
        arguments={"hostname": "host", "service": "nginx"},
        action="Restart nginx",
        request_code="ACT-2026-01234567",
        result={"approval_user_id": "owner-id"},
    )
    db = MagicMock()

    def execute(query):
        entity = query.column_descriptions[0]["entity"].__name__
        if entity == "AIAction":
            assert query._for_update_arg is not None
            return NS(scalar_one_or_none=lambda: a)
        return NS(
            scalar_one_or_none=lambda: NS(id="owner-id", is_active=True, role="admin")
        )

    db.execute.side_effect = execute

    def state(*args):
        assert a.status in ("executing", "executed")
        if a.status == "executing":
            db.commit.assert_called()

    executor = MagicMock(return_value={"available": True})
    with patch("worker_ai.tasks.SessionLocal") as session, patch(
        "worker_ai.tasks.set_agent_state", side_effect=state
    ), patch("worker_ai.tasks.EXECUTORS", {"restart_service": executor}):
        session.return_value.__enter__.return_value = db
        execute_action_task("action")
        execute_action_task("action")
    executor.assert_called_once()
    assert a.status == "executed"


def test_worker_rejects_revoked_talk_binding_before_executor():
    now = datetime.now(timezone.utc)
    agent = NS(
        enabled=True,
        allowed_tools=["restart_service"],
        allowed_hosts=[],
        allowed_environments=[],
    )
    a = NS(
        status="approved",
        task_id="task",
        approved_by="owner",
        approval_level=2,
        expires_at=now + timedelta(minutes=5),
        agent=agent,
        tool="restart_service",
        arguments={"hostname": "host"},
        result={"approval_user_id": "owner-id", "approval_source": "talk"},
    )
    db = MagicMock()

    def execute(query):
        entity = query.column_descriptions[0]["entity"].__name__
        value = (
            a
            if entity == "AIAction"
            else (
                "completed"
                if entity == "AITask"
                else NS(id="owner-id", is_active=True, role="admin")
            )
        )
        return NS(scalar_one_or_none=lambda: value)

    db.execute.side_effect = execute
    db.get.return_value = NS(owner_user_id="owner-id")
    executor = MagicMock()
    with patch("worker_ai.tasks.SessionLocal") as session, patch(
        "app.core.talk_memory.task_binding_valid", return_value=False
    ), patch("worker_ai.tasks.EXECUTORS", {"restart_service": executor}):
        session.return_value.__enter__.return_value = db
        execute_action_task("action")
    assert a.status == "expired"
    executor.assert_not_called()

def test_service_query_cannot_publish_persistent_monitoring_metrics():
    from worker_ai.ai.tools.linux_tools import get_service_status
    with patch("worker_ai.ai.tools.linux_tools.run_ansible_query") as query:
        get_service_status("edge-host", "httpd")
    assert query.call_args.args[2]["query_only"] is True
