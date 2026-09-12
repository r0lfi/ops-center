"""Integration tests use ONLY a dedicated disposable PostgreSQL database.

COLLAB_TEST_DATABASE_URL=postgresql+psycopg://postgres@/ops_collaboration_test?host=/tmp/ops-collaboration-pg
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session
from app.models.ai import AIAgent, AIProvider, AITask, AIUsage
from app.models.user import User
from app.models.audit import AuditLogEntry
from app.models.ai_collaboration import (
    AICollaborationSettings as Settings, AICollaborationBoard as Board,
    AICollaborationPost as Post, AICollaborationDailyUsage as Daily,
    AICollaborationReservation as Reservation,
)
from app.schemas.ai_collaboration import CollaborationPolicy, AgentPermissions
from worker_ai.ai.collaboration import Collaboration, CollaborationStopped, begin, now
from worker_ai.ai.providers.base import ProviderResult, ToolCall
from worker_ai.ai.runtime import run_agent

TABLES = [User.__table__, AIProvider.__table__, AIAgent.__table__, AITask.__table__, AIUsage.__table__, AuditLogEntry.__table__,
          Settings.__table__, Board.__table__, Post.__table__, Daily.__table__, Reservation.__table__]

@pytest.fixture
def database():
    url = os.getenv("COLLAB_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Dedicated collaboration PostgreSQL database not configured")
    engine = create_engine(url)
    assert engine.url.database == "ops_collaboration_test", "Refusing to modify any other database"
    from app.db.base import Base
    Base.metadata.drop_all(engine, tables=TABLES)
    Base.metadata.create_all(engine, tables=TABLES)
    with Session(engine, expire_on_commit=False) as db:
        user = User(username="owner", password_hash="test", role="admin")
        provider = AIProvider(slug="test", kind="ollama", display_name="Test", enabled=True, default_model="test")
        db.add_all([user, provider])
        db.flush()
        agents = {}
        for slug in ("coordinator", "linux", "network"):
            agent = AIAgent(slug=slug, name=slug, provider_id=provider.id, model=slug, enabled=True,
                            system_prompt=slug, allowed_tools=[], allowed_hosts=[], allowed_environments=[],
                            max_tool_calls=8, max_execution_seconds=90)
            db.add(agent)
            agents[slug] = agent
        db.flush()
        policy = CollaborationPolicy(enabled=True, max_tokens=150000, max_daily_tokens=500000,
            agents={slug: AgentPermissions(peers=[p for p in agents if p != slug]) for slug in agents})
        db.add(Settings(id=1, revision=1, policy=policy.model_dump()))
        task = AITask(agent_id=agents["coordinator"].id, owner_user_id=user.id, requested_by=user.username,
                      source="collaboration", input_message="Investigate connectivity", status="running")
        db.add(task)
        db.flush()
        db.add(Board(task_id=task.id, owner_user_id=user.id, policy=policy.model_dump(), participants=["coordinator"],
                     requests=[], status="queued", expires_at=now() + timedelta(minutes=5)))
        db.commit()
        yield SimpleNamespace(engine=engine, db=db, task=task, user=user, agents=agents, policy=policy)
    engine.dispose()

class FakeProvider:
    def __init__(self):
        self.calls = []
        self.counts = {}
    def chat(self, **kw):
        self.calls.append(kw)
        model = kw["model"]
        count = self.counts.get(model, 0)
        self.counts[model] = count + 1
        if count == 0 and model != "network":
            target = "linux" if model == "coordinator" else "network"
            return ProviderResult(text="", stop_reason="tool_use",
                tool_calls=[ToolCall("ask-" + model, "collaboration_ask", {"agent": target, "question": "Check the return route for " + target})],
                assistant_message={"role": "assistant", "content": "Request specialist help"}, input_tokens=100, output_tokens=60)
        return ProviderResult(text=model + ": route evidence collected", assistant_message={"role": "assistant", "content": "route evidence collected"}, input_tokens=100, output_tokens=60)
    def tool_result_messages(self, calls, results):
        return [{"role": "tool", "content": content} for content in results]

def test_three_agents_share_board_and_one_budget(database):
    d = database
    provider = FakeProvider()
    with patch("worker_ai.ai.runtime.build_provider", return_value=provider), patch("worker_ai.ai.runtime.set_agent_state"), patch("worker_ai.ai.agent_state.set_agent_state"):
        result = run_agent(d.db, d.agents["coordinator"], d.task.input_message, task_id=str(d.task.id))
    board = d.db.get(Board, d.task.id, populate_existing=True)
    posts = list(d.db.execute(select(Post).order_by(Post.sequence)).scalars())
    assert result.agents_used == ["coordinator", "linux", "network"]
    assert [p.kind for p in posts] == ["question", "question", "answer", "answer", "answer"]
    assert board.status == "completed" and board.model_calls == 5
    assert board.actual_tokens == 800 and board.charged_tokens > board.actual_tokens
    assert all(c["max_tokens"] == d.policy.max_output_tokens for c in provider.calls)
    assert d.db.scalar(select(func.count()).select_from(AIUsage)) == 5

def test_exhausted_budget_does_not_call_provider(database):
    d = database
    board = d.db.get(Board, d.task.id)
    board.policy = {**board.policy, "max_tokens": 2000, "max_output_tokens": 128}
    d.db.commit()
    with patch("worker_ai.ai.runtime.build_provider") as build, patch("worker_ai.ai.runtime.set_agent_state"):
        result = run_agent(d.db, d.agents["coordinator"], "Large context " * 1000, task_id=str(d.task.id))
    build.return_value.chat.assert_not_called()
    assert "token budget" in result.text
    assert d.db.get(Board, d.task.id).model_calls == 0

def test_atomic_reservations_prevent_double_spending(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    policy = d.db.get(Settings, 1)
    policy.policy = {**policy.policy, "max_tokens": 5000, "max_daily_tokens": 5000}
    d.db.commit()
    def reserve():
        with Session(d.engine, expire_on_commit=False) as session:
            agent = session.get(AIAgent, d.agents["coordinator"].id)
            ctx = Collaboration(session, d.task.id, agent, d.policy)
            try:
                return str(ctx.reserve(agent, "", [], [])[0])
            except CollaborationStopped:
                session.rollback()
                return "denied"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: reserve(), range(2)))
    assert results.count("denied") == 1
    d.db.expire_all()
    assert d.db.get(Board, d.task.id).model_calls == 1
    assert d.db.get(Daily, now().date()).charged_tokens <= 5000

def test_uncertain_usage_keeps_charge_and_settlement_is_idempotent(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    reservation, _ = c.reserve(d.agents["coordinator"], "context", [], [])
    before = c.board().charged_tokens
    c.settle(reservation, 0, 0)
    c.settle(reservation, 100, 100)
    assert c.board().charged_tokens == before
    assert d.db.get(Reservation, reservation).status == "unknown"

@pytest.mark.parametrize("change", ["enabled", "read", "scope", "owner", "expired", "stopped"])
def test_revocation_and_stops_block_next_call(database, change):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    board = c.board()
    if change in ("enabled", "read"):
        policy = d.policy.model_copy(deep=True)
        if change == "enabled":
            policy.enabled = False
        else:
            policy.agents["coordinator"].read = False
            policy.agents["coordinator"].post = policy.agents["coordinator"].ask = policy.agents["coordinator"].respond = False
        d.db.get(Settings, 1).policy = policy.model_dump()
    elif change == "scope":
        d.agents["coordinator"].allowed_hosts = ["other"]
    elif change == "owner":
        d.user.is_active = False
    elif change == "expired":
        board.expires_at = now() - timedelta(seconds=1)
    else:
        board.status, board.stop_reason = "stopped", "Stopped by owner"
    d.db.commit()
    with pytest.raises(CollaborationStopped):
        c.reserve(d.agents["coordinator"], "", [], [])
    assert c.board().model_calls == 0

def test_cycles_partners_and_scope_are_enforced(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    c.stack = ["coordinator"]
    assert "Circular" in c.ask(d.agents["linux"], "coordinator", "Again?")["error"]
    assert "not permitted" in c.ask(d.agents["coordinator"], "unknown", "Help?")["error"]
    d.agents["network"].allowed_hosts = ["restricted"]
    d.db.commit()
    assert "identical" in c.ask(d.agents["coordinator"], "network", "Help?")["error"]

def test_duplicate_question_is_not_rerun(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    c.stack = ["coordinator"]
    with patch("worker_ai.ai.runtime.run_agent", return_value=SimpleNamespace(text="result", tools_used=[], data_sources=[])) as run, patch("worker_ai.ai.agent_state.set_agent_state"):
        c.ask(d.agents["coordinator"], "linux", "Check   routes")
        result = c.ask(d.agents["coordinator"], "linux", "check routes")
    assert "already" in result["error"]
    run.assert_called_once()

def test_actions_and_memory_tools_cannot_be_granted():
    with pytest.raises(ValueError):
        AgentPermissions(tools=["execute_shell"])
    with pytest.raises(ValueError):
        AgentPermissions(tools=["remember_fact"])
    with pytest.raises(ValueError):
        CollaborationPolicy(agents={"a": AgentPermissions(peers=["missing"])})

def test_board_read_is_owner_only_and_settings_admin_only(database):
    from fastapi import FastAPI, Depends
    from fastapi.testclient import TestClient
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.api.routes.ai_collaboration import router
    from app.api.deps import get_current_user
    from app.db.session import get_db
    d = database
    engine = create_async_engine(str(d.engine.url).replace("+psycopg", "+asyncpg"))
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async def db_override():
        async with factory() as session:
            yield session
    current = SimpleNamespace(id=d.user.id, username="owner", role="viewer", is_active=True)
    app = FastAPI()
    app.include_router(router, prefix="/api", dependencies=[Depends(get_current_user)])
    from app.api.routes.ai import router as ai_router
    app.include_router(ai_router, prefix="/api", dependencies=[Depends(get_current_user)])
    app.dependency_overrides[get_db] = db_override
    app.dependency_overrides[get_current_user] = lambda: current
    with TestClient(app) as client:
        path = "/api/ai/collaboration/boards/" + str(d.task.id)
        assert client.get(path).status_code == 200
        payload = {"revision": 1, "policy": d.policy.model_dump()}
        assert client.put("/api/ai/collaboration/settings", json=payload).status_code == 403
        current.id = uuid.uuid4()
        assert client.get(path).status_code == 404
        assert client.get("/api/ai/tasks/" + str(d.task.id)).status_code == 404
        assert client.get("/api/ai/tasks").json() == []
        assert client.post(path + "/stop").status_code == 404
        assert client.get("/api/ai/collaboration/boards").json() == []
        current.id, current.role = d.user.id, "admin"
        assert client.put("/api/ai/collaboration/settings", json=payload).status_code == 200
        assert client.put("/api/ai/collaboration/settings", json=payload).status_code == 409
        assert client.post(path + "/stop").status_code == 200
    import asyncio
    asyncio.run(engine.dispose())

def test_missing_output_usage_is_not_refunded(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    reservation, _ = c.reserve(d.agents["coordinator"], "context", [], [])
    before = c.board().charged_tokens
    c.settle(reservation, 100, 0)
    assert c.board().charged_tokens == before

def test_provider_exceeding_estimate_stops_further_work(database):
    d = database
    c = begin(d.db, d.agents["coordinator"], str(d.task.id))
    reservation, _ = c.reserve(d.agents["coordinator"], "", [], [])
    c.settle(reservation, 100000, 100)
    assert c.board().status == "stopped"
    with pytest.raises(CollaborationStopped):
        c.reserve(d.agents["coordinator"], "", [], [])

def test_operational_tools_are_denied_even_if_model_requests_them(database):
    d = database
    d.agents["coordinator"].allowed_tools = ["run_shell_command"]
    d.db.commit()
    provider = FakeProvider()
    provider.chat = __import__("unittest.mock", fromlist=["MagicMock"]).MagicMock(side_effect=[
        ProviderResult(text="", stop_reason="tool_use", tool_calls=[ToolCall("write", "run_shell_command", {"command": "touch /tmp/should-not-exist"})], assistant_message={"role": "assistant", "content": ""}, input_tokens=100, output_tokens=100),
        ProviderResult(text="No operational changes performed", assistant_message={"role": "assistant", "content": "done"}, input_tokens=100, output_tokens=100),
    ])
    with patch("worker_ai.ai.runtime.build_provider", return_value=provider), patch("worker_ai.ai.runtime.set_agent_state"), patch("worker_ai.ai.runtime.request_approval") as approval, patch("worker_ai.ai.runtime._safe_read") as read:
        run_agent(d.db, d.agents["coordinator"], "Investigate", task_id=str(d.task.id))
    approval.assert_not_called()
    read.assert_not_called()
    assert "not permitted" in provider.chat.call_args.kwargs["messages"][-2]["content"]

def test_public_agent_state_hides_collaboration_content():
    from worker_ai.ai.collaboration import CURRENT
    from worker_ai.ai.agent_state import set_agent_state
    token = CURRENT.set(object())
    agent = SimpleNamespace(slug="linux", error_message=None)
    try:
        with patch("worker_ai.ai.agent_state.publish_agent_event") as publish:
            set_agent_state(SimpleNamespace(commit=lambda: None), agent, "working", "Private question and hostname", "private-host", "private-task")
        assert agent.current_task == "Collaboration investigation"
        publish.assert_called_once_with("linux", "working", "Collaboration investigation", None, None)
    finally:
        CURRENT.reset(token)

def test_migration_upgrade_and_downgrade(database):
    import importlib.util
    from pathlib import Path
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path = Path(__file__).resolve().parents[2] / "backend/migrations/versions/0037_ai_collaboration.py"
    spec = importlib.util.spec_from_file_location("collaboration_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    database.db.close()
    with database.engine.begin() as connection:
        for table in (Reservation.__table__, Daily.__table__, Post.__table__, Board.__table__, Settings.__table__):
            table.drop(connection)
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            assert connection.execute(select(Settings.revision)).scalar_one() == 1
            module.downgrade()
            module.upgrade()
