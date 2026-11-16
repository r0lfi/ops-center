"""Board, resume and tool-proposal routes on real PostgreSQL (schema at head).

    BOARD_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_board_test?host=/path/to/socket' pytest
"""
import asyncio
import os
import uuid
from unittest.mock import MagicMock, patch

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.deps import get_current_user
from app.api.routes.ai_developer import patch_sha256, require_release_auth
from app.db.session import get_db
from app.main import app
from app.models.ai import AIAgent, AIChangeReview, AITask, AIToolProposal, AIWorkItem
from app.models.user import User

URL = os.environ.get("BOARD_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_board_test" not in URL, reason="needs BOARD_TEST_DATABASE_URL for ops_board_test")


def scenario(body):
    async def run():
        engine = create_async_engine(URL)
        assert engine.url.database == "ops_board_test"
        maker = async_sessionmaker(engine, expire_on_commit=False)
        async with maker() as db:
            for table in ("ai_change_reviews", "ai_work_items", "ai_tool_proposals", "ai_findings", "ai_usage", "ai_actions", "ai_tasks"):
                await db.execute(text(f"DELETE FROM {table}"))
            await db.execute(text("DELETE FROM users WHERE username LIKE 'route-%'"))
            users = {role: User(username=f"route-{role}", password_hash="x", role=role, is_active=True) for role in ("admin", "operator")}
            db.add_all(users.values())
            await db.commit()
            current = {"user": users["admin"]}

            async def database():
                async with maker() as session:
                    yield session

            app.dependency_overrides[get_db] = database
            app.dependency_overrides[get_current_user] = lambda: current["user"]
            # A recently confirmed password is tested in test_sessions_pg/test_developer_gate.
            app.dependency_overrides[require_release_auth] = lambda: current["user"]
            celery = MagicMock()
            try:
                with patch("app.api.routes.ai_board.get_celery_client", return_value=celery):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                        await body(client, db, users, current, celery)
            finally:
                app.dependency_overrides.clear()
        await engine.dispose()
    asyncio.run(run())


async def _coordinator(db):
    return (await db.execute(select(AIAgent).where(AIAgent.slug == "coordinator"))).scalar_one()


def test_board_shows_items_and_resume_is_owner_only_and_once():
    async def body(client, db, users, current, celery):
        coordinator = await _coordinator(db)
        task = AITask(agent_id=coordinator.id, owner_user_id=users["operator"].id, source="web", input_message="Why is Nextcloud slow?",
                      status="completed", outcome="inconclusive", response_message="Partial")
        db.add(task)
        await db.flush()
        db.add(AIWorkItem(task_id=task.id, agent_slug="monitoring", title="logs", status="completed", depends_on=[], tools=["search_logs"]))
        await db.commit()
        board = (await client.get(f"/api/ai/tasks/{task.id}/board")).json()
        assert board["outcome"] == "inconclusive" and board["items"][0]["tools"] == ["search_logs"]
        assert board["resumable"] is False  # admin is not the owner
        assert (await client.post(f"/api/ai/tasks/{task.id}/resume")).status_code == 403
        current["user"] = users["operator"]
        assert (await client.get(f"/api/ai/tasks/{task.id}/board")).json()["resumable"] is True
        created = await client.post(f"/api/ai/tasks/{task.id}/resume")
        assert created.status_code == 201
        new = await db.get(AITask, uuid.UUID(created.json()["task_id"]))
        assert new.resumed_from == task.id and new.status == "queued"
        celery.send_task.assert_called_once()
        assert (await client.post(f"/api/ai/tasks/{task.id}/resume")).status_code == 409
    scenario(body)


def test_proposal_approval_is_admin_only_and_starts_development_only():
    async def body(client, db, users, current, celery):
        proposal = AIToolProposal(title="tls_check diagnostic", details={"missing": "TLS check"}, status="proposed")
        db.add(proposal)
        await db.commit()
        current["user"] = users["operator"]
        assert (await client.post(f"/api/ai/proposals/{proposal.id}/approve")).status_code == 403
        current["user"] = users["admin"]
        approved = (await client.post(f"/api/ai/proposals/{proposal.id}/approve")).json()
        assert approved["status"] == "in_development" and approved["dev_task_id"]
        dev = await db.get(AITask, uuid.UUID(approved["dev_task_id"]))
        developer = await db.get(AIAgent, dev.agent_id)
        assert dev.source == "development" and developer.slug == "developer"
        assert set(developer.allowed_tools) == {"list_repo_files", "read_repo_file", "search_code"}
        assert (await client.post(f"/api/ai/proposals/{proposal.id}/approve")).status_code == 409
        assert (await client.get(f"/api/ai/proposals/{proposal.id}/patch")).status_code == 404
        current["user"] = users["operator"]
        assert (await client.get("/api/ai/proposals")).json() == []  # not the owner: hidden
        current["user"] = users["admin"]
        assert [p["id"] for p in (await client.get("/api/ai/proposals")).json()] == [str(proposal.id)]
        # In development, without a reviewed and approved patch, a release cannot be recorded.
        assert (await client.post(f"/api/ai/proposals/{proposal.id}/deployed", json={"note": "release abc"})).status_code == 409
        assert (await client.post(f"/api/ai/proposals/{proposal.id}/reject")).json()["status"] == "rejected"
        assert (await client.post(f"/api/ai/proposals/{proposal.id}/reject")).status_code == 409
    scenario(body)


def test_mcp_agent_access_reports_expired_grants_instead_of_hiding_them():
    from datetime import datetime, timedelta, timezone
    from app.models.mcp import MCPClient, MCPGrant, MCPSettings

    async def body(client, db, users, current, celery):
        settings = await db.get(MCPSettings, 1)
        if settings is None:
            settings = MCPSettings(id=1, enabled=True)
            db.add(settings)
        settings.enabled = True
        await db.execute(text("DELETE FROM mcp_grants WHERE user_id = :u"), {"u": users["admin"].id})
        monitoring = (await db.execute(select(AIAgent).where(AIAgent.slug == "monitoring"))).scalar_one()
        monitoring.allowed_tools = ["get_alerts", "ops_list_alerts", "ops_health"]
        cid = "internal:test-" + uuid.uuid4().hex[:8]
        db.add(MCPClient(id=cid, name="t", redirect_uris=[], scopes=[], allowed_tools=["ops_list_alerts"], allowed_user_ids=[str(users["admin"].id)]))
        await db.flush()
        db.add(MCPGrant(client_id=cid, user_id=users["admin"].id, agent_id=monitoring.id, scopes=[], allowed_tools=["ops_list_alerts", "ops_health"],
                        resource="https://ops.example/mcp", expires_at=datetime.now(timezone.utc) - timedelta(days=31)))
        await db.commit()
        view = (await client.get("/api/mcp/agent-access")).json()
        row = next(r for r in view["rows"] if r["agent_slug"] == "monitoring" and r["user_id"] == str(users["admin"].id))
        assert row["status"] == "expired" and row["expired_at"] and row["granted_tools"] == []
        assert sorted(row["missing_tools"]) == ["ops_health", "ops_list_alerts"]
        current["user"] = users["operator"]
        rows = (await client.get("/api/mcp/agent-access")).json()["rows"]
        assert all(r["user_id"] == str(users["operator"].id) for r in rows)
    scenario(body)



def test_a_manually_implemented_proposal_can_be_marked_released():
    async def body(client, db, users, current, celery):
        proposal = AIToolProposal(title="file_grep", details={}, status="proposed")
        db.add(proposal)
        await db.commit()
        released = (await client.post(f"/api/ai/proposals/{proposal.id}/deployed", json={"note": "written by hand"})).json()
        assert released["status"] == "deployed" and "written by hand" in released["patch_notes"]
        celery.send_task.assert_not_called()
    scenario(body)



def test_a_patch_still_being_written_is_not_downloadable():
    async def body(client, db, users, current, celery):
        proposal = AIToolProposal(title="half", details={}, status="in_development", patch="diff --git a/x b/x\n")
        db.add(proposal)
        await db.commit()
        listed = next(p for p in (await client.get("/api/ai/proposals")).json() if p["id"] == str(proposal.id))
        assert listed["has_patch"] is False
        assert (await client.get(f"/api/ai/proposals/{proposal.id}/patch")).status_code == 404
        proposal.status = "ready_for_review"
        await db.commit()
        assert (await client.get(f"/api/ai/proposals/{proposal.id}/patch")).text.startswith("diff --git")
    scenario(body)



PATCH = "diff --git a/worker_ai/ai/tools/file_grep.py b/worker_ai/ai/tools/file_grep.py\nnew file mode 100644\n--- /dev/null\n+++ b/worker_ai/ai/tools/file_grep.py\n+x = 1\n" \
        "diff --git a/worker_ai/tests/test_file_grep.py b/worker_ai/tests/test_file_grep.py\n--- a/worker_ai/tests/test_file_grep.py\n+++ b/worker_ai/tests/test_file_grep.py\n-old\n+new\n"


def test_review_gate_binds_approval_to_patch_and_release_needs_approval():
    async def body(client, db, users, current, celery):
        proposal = AIToolProposal(title="file_grep", details={"missing": "grep"}, status="ready_for_review", patch=PATCH)
        db.add(proposal)
        await db.commit()
        pid = proposal.id
        detail = (await client.get(f"/api/ai/developer/changes/{pid}")).json()
        assert [f["path"] for f in detail["files_changed"]] == ["worker_ai/ai/tools/file_grep.py", "worker_ai/tests/test_file_grep.py"]
        assert detail["files_changed"][0]["status"] == "added" and detail["files_changed"][1]["kind"] == "test"
        assert {c["name"]: c["result"] for c in detail["checks"]}["Test run"] == "not_run"
        # Release before approval is refused.
        assert (await client.post(f"/api/ai/proposals/{pid}/deployed", json={})).status_code == 409
        # An approval names the patch the reviewer saw.
        stale = "0" * 64
        assert (await client.post(f"/api/ai/proposals/{pid}/review", json={"decision": "approve", "patch_sha256": stale})).status_code == 409
        sha = detail["patch_sha256"]
        assert sha == patch_sha256(PATCH)
        ok = await client.post(f"/api/ai/proposals/{pid}/review", json={"decision": "approve", "patch_sha256": sha})
        assert ok.json()["stage"] == "approved"
        # The stored patch changes afterwards (e.g. directly in the database): the approval no longer covers it.
        await db.execute(text("UPDATE ai_tool_proposals SET patch = patch || '+evil\n' WHERE id = :id"), {"id": pid})
        await db.commit()
        assert (await client.post(f"/api/ai/proposals/{pid}/deployed", json={})).status_code == 409
        await db.execute(text("UPDATE ai_tool_proposals SET patch = :p WHERE id = :id"), {"p": PATCH, "id": pid})
        await db.commit()
        released = await client.post(f"/api/ai/proposals/{pid}/deployed", json={"release_ref": "abc1234"})
        assert released.json()["status"] == "deployed"
        rolled = await client.post(f"/api/ai/proposals/{pid}/release-outcome", json={"outcome": "rolled_back", "note": "broke search"})
        assert rolled.json()["stage"] == "rolled_back"
        reviews = (await db.execute(select(AIChangeReview).where(AIChangeReview.proposal_id == pid)
                                    .order_by(AIChangeReview.decided_at))).scalars().all()
        assert [r.decision for r in reviews] == ["approve", "released", "rolled_back"]
        assert reviews[0].patch_sha256 == sha and reviews[1].release_ref == "abc1234"
        assert all(r.decided_by == "route-admin" for r in reviews)
        overview = (await client.get("/api/ai/developer/overview")).json()
        item = next(i for i in overview["items"] if i["id"] == str(pid))
        assert item["stage"] == "rolled_back" and item["approved_by"] == "route-admin" and item["release_ref"] == "abc1234"
        # Decisions are append-only.
        with pytest.raises(Exception):
            await db.execute(text("UPDATE ai_change_reviews SET decided_by = 'someone'"))
        await db.rollback()
    scenario(body)


def test_request_changes_needs_a_comment_and_reruns_the_developer_with_it():
    async def body(client, db, users, current, celery):
        proposal = AIToolProposal(title="rework", details={"missing": "x"}, status="ready_for_review", patch=PATCH)
        db.add(proposal)
        await db.commit()
        pid = proposal.id
        assert (await client.post(f"/api/ai/proposals/{pid}/review", json={"decision": "request_changes"})).status_code == 422
        r = await client.post(f"/api/ai/proposals/{pid}/review", json={"decision": "request_changes", "comment": "add a size limit"})
        assert r.json()["stage"] == "changes_requested"
        started = await client.post(f"/api/ai/proposals/{pid}/approve")
        assert started.status_code == 200 and started.json()["status"] == "in_development"
        task = await db.get(AITask, uuid.UUID(started.json()["dev_task_id"]))
        assert "add a size limit" in task.input_message
        await db.refresh(proposal)
        assert proposal.patch is None
    scenario(body)


def test_a_patch_outside_the_allowlist_cannot_be_approved_and_others_see_nothing():
    async def body(client, db, users, current, celery):
        bad = "diff --git a/compose.yml b/compose.yml\n--- a/compose.yml\n+++ b/compose.yml\n+x\n"
        proposal = AIToolProposal(title="bad", details={}, status="ready_for_review", patch=bad)
        db.add(proposal)
        await db.commit()
        r = await client.post(f"/api/ai/proposals/{proposal.id}/review", json={"decision": "approve", "patch_sha256": patch_sha256(bad)})
        assert r.status_code == 409
        current["user"] = users["operator"]
        assert (await client.get(f"/api/ai/developer/changes/{proposal.id}")).status_code == 404
        assert (await client.get("/api/ai/developer/overview")).json()["items"] == []
    scenario(body)


def test_one_agent_with_twelve_tasks_is_one_busy_agent():
    from datetime import datetime, timedelta, timezone

    async def body(client, db, users, current, celery):
        developer = (await db.execute(select(AIAgent).where(AIAgent.slug == "developer"))).scalar_one()
        monitoring = (await db.execute(select(AIAgent).where(AIAgent.slug == "monitoring"))).scalar_one()
        now = datetime.now(timezone.utc)
        for i in range(12):
            db.add(AITask(agent_id=developer.id, input_message=f"t{i}", status="running", source="development", started_at=now))
        db.add(AITask(agent_id=developer.id, input_message="done", status="completed", started_at=now))
        # Abandoned by a worker restart long ago: not counted.
        db.add(AITask(agent_id=monitoring.id, input_message="stale", status="running",
                      started_at=now - timedelta(seconds=monitoring.max_execution_seconds + 3600)))
        db.add(AITask(agent_id=monitoring.id, input_message="waiting", status="queued"))
        await db.commit()
        agents = {a["slug"]: a for a in (await client.get("/api/ai/agents")).json()}
        assert agents["developer"]["running_tasks"] == 12 and agents["developer"]["queued_tasks"] == 0
        assert agents["monitoring"]["running_tasks"] == 0 and agents["monitoring"]["queued_tasks"] == 1
        busy = [slug for slug, a in agents.items() if a["running_tasks"]]
        assert busy == ["developer"]  # twelve tasks, one active agent
        assert sum(a["running_tasks"] for a in agents.values()) == 12
    scenario(body)


def test_weekly_budget_limit_needs_a_confirmed_admin_and_applies_at_once():
    from app.api.routes.ai_budget import require_budget_auth
    from app.models.ai_budget import AIBudgetSettings

    async def body(client, db, users, current, celery):
        await db.execute(text("DELETE FROM ai_budget_settings"))
        await db.commit()
        assert (await client.get("/api/ai/budget")).json()["limit_usd"] == 20.0  # default without a row
        # Without a recently confirmed password (no browser session here) the change is refused.
        assert (await client.put("/api/ai/budget", json={"limit_usd": 35})).status_code == 403
        app.dependency_overrides[require_budget_auth] = lambda: current["user"]
        assert (await client.put("/api/ai/budget", json={"limit_usd": 0.5})).status_code == 422
        assert (await client.put("/api/ai/budget", json={"limit_usd": 5000})).status_code == 422
        saved = (await client.put("/api/ai/budget", json={"limit_usd": 35})).json()
        assert saved["limit_usd"] == 35.0 and saved["warning_usd"] == 28.0
        row = await db.get(AIBudgetSettings, 1)
        await db.refresh(row)
        assert row.updated_by == "route-admin"
        await db.execute(text("DELETE FROM ai_budget_settings"))
        await db.commit()

    scenario(body)
