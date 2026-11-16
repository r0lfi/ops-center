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
from app.models.ai_budget import AIBudgetWeek, AIBudgetReservation
from app.models.ai import AIAgent, AIProvider, AITask, AIUsage
from app.models.user import User
from app.models.ai_memory import AIMemoryPreference
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

TABLES = [AIBudgetWeek.__table__, AIBudgetReservation.__table__, AIMemoryPreference.__table__, User.__table__, AIProvider.__table__, AIAgent.__table__, AITask.__table__, AIUsage.__table__, AuditLogEntry.__table__,
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
                            max_tool_calls=8, max_execution_seconds=300)
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
    with patch("worker_ai.ai.runtime.memory_owner", return_value=d.user.id) as personal_owner, patch("worker_ai.ai.runtime.note_context", return_value="PRIVATE_NOTE_SENTINEL") as personal_notes, patch("worker_ai.ai.runtime.reserve_usd", return_value=None), patch("worker_ai.ai.runtime.settle_usd"), patch("worker_ai.ai.runtime.build_provider", return_value=provider), patch("worker_ai.ai.runtime.set_agent_state"), patch("worker_ai.ai.agent_state.set_agent_state"):
        result = run_agent(d.db, d.agents["coordinator"], d.task.input_message, task_id=str(d.task.id))
    personal_owner.assert_not_called()
    personal_notes.assert_not_called()
    assert all("PRIVATE_NOTE_SENTINEL" not in str(call) for call in provider.calls)
    assert all(not ({"recall_memory", "remember_fact"} & {tool["name"] for tool in call["tools"]}) for call in provider.calls)
    board = d.db.get(Board, d.task.id, populate_existing=True)
    posts = list(d.db.execute(select(Post).order_by(Post.sequence)).scalars())
    assert result.agents_used == ["coordinator", "linux", "network"]
    assert [p.kind for p in posts] == ["question", "question", "answer", "answer", "summary"]
    assert posts[2].reply_to_id == posts[1].id and posts[2].recipient == "linux"
    assert posts[3].reply_to_id == posts[0].id and posts[3].recipient == "coordinator"
    assert posts[4].reply_to_id is None and posts[4].recipient is None
    assert board.status == "completed" and board.model_calls == 5
    assert board.actual_tokens == 800 and board.charged_tokens > board.actual_tokens
    assert all(c["max_tokens"] == d.policy.max_output_tokens for c in provider.calls)
    assert d.db.scalar(select(func.count()).select_from(AIUsage)) == 5

def test_exhausted_budget_does_not_call_provider(database):
    d = database
    board = d.db.get(Board, d.task.id)
    board.policy = {**board.policy, "max_tokens": 2000, "max_output_tokens": 128}
    d.db.commit()
    with patch("worker_ai.ai.runtime.reserve_usd", return_value=None), patch("worker_ai.ai.runtime.settle_usd"), patch("worker_ai.ai.runtime.build_provider") as build, patch("worker_ai.ai.runtime.set_agent_state"):
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
    # Keep the URL object: converting it to text masks password credentials.
    engine = create_async_engine(d.engine.url.set(drivername="postgresql+asyncpg"))
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
    with patch("worker_ai.ai.runtime.reserve_usd", return_value=None), patch("worker_ai.ai.runtime.settle_usd"), patch("worker_ai.ai.runtime.build_provider", return_value=provider), patch("worker_ai.ai.runtime.set_agent_state"), patch("worker_ai.ai.runtime.request_approval") as approval, patch("worker_ai.ai.runtime._safe_read") as read:
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
        publish.assert_called_once_with("linux", "working", "Collaboration investigation", None, None, event=None, peer=None, tool=None)
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


def _experience(d, *, owner=None, scope="current", content="Verified diagnostic source: synthetic metric; recovery cause remains uncertain", status="completed", task_status="completed", kind="experience", agent="linux"):
    from worker_ai.ai.collaboration import scope_snapshot
    when = now() - timedelta(minutes=10)
    user_id = owner or d.user.id
    task = AITask(agent_id=d.agents["coordinator"].id, owner_user_id=user_id, requested_by="synthetic",
        source="collaboration", input_message="Earlier investigation", status=task_status, created_at=when)
    d.db.add(task); d.db.flush()
    board = Board(task_id=task.id, owner_user_id=user_id, policy=d.policy.model_dump(),
        scope_snapshot=scope_snapshot(d.agents["coordinator"]) if scope == "current" else scope,
        participants=["coordinator", agent], requests=[], status=status,
        created_at=when, expires_at=when+timedelta(minutes=5))
    d.db.add(board); d.db.flush()
    post = Post(task_id=task.id, sequence=1, agent=agent, kind=kind, content=content, created_at=when)
    d.db.add(post); d.db.commit()
    return post


def _experience_context(d):
    from worker_ai.ai.collaboration import scope_snapshot
    d.db.get(Board, d.task.id).scope_snapshot = scope_snapshot(d.agents["coordinator"])
    d.db.commit()
    return begin(d.db, d.agents["coordinator"], str(d.task.id))


def test_experiences_are_owner_scope_kind_and_completion_filtered(database):
    d = database
    context = _experience_context(d)
    selected = _experience(d, content="capacity synthetic-memory-source")
    other = User(username="other-memory-owner", password_hash="test", role="admin")
    d.db.add(other); d.db.commit()
    _experience(d, owner=other.id, content="PRIVATE_OTHER_OWNER")
    _experience(d, scope=None, content="LEGACY_UNSCOPED")
    _experience(d, scope={"allowed_hosts":["restricted-host"],"allowed_environments":[]}, content="PRIVATE_OTHER_SCOPE")
    _experience(d, status="failed", content="FAILED_BOARD")
    _experience(d, task_status="failed", content="FAILED_TASK")
    _experience(d, kind="evidence", content="NOT_AN_EXPERIENCE")
    result = context.recall(d.agents["coordinator"], "")
    assert [row["post_id"] for row in result["experiences"]] == [str(selected.id)]
    assert result["experiences"][0]["task_id"] == str(selected.task_id)
    assert result["experiences"][0]["agent"] == "linux"
    assert "created_at" in result["experiences"][0]
    assert "current verification" in result["notice"]
    assert "PRIVATE" not in str(result)


@pytest.mark.parametrize("change", ["disabled", "read", "scope", "missing"])
def test_experience_reuse_rechecks_all_historical_participants(database, change):
    d = database
    context = _experience_context(d)
    _experience(d)
    assert len(context.recall(d.agents["coordinator"], "")["experiences"]) == 1
    if change == "disabled":
        d.agents["linux"].enabled = False
    elif change == "read":
        policy = d.policy.model_copy(deep=True)
        grant = policy.agents["linux"]
        grant.read = grant.post = grant.ask = grant.respond = False
        d.db.get(Settings, 1).policy = policy.model_dump()
    elif change == "scope":
        d.agents["linux"].allowed_environments = ["restricted"]
    else:
        from sqlalchemy import delete
        d.db.execute(delete(AIAgent).where(AIAgent.id == d.agents["linux"].id))
    d.db.commit()
    assert context.recall(d.agents["coordinator"], "")["experiences"] == []


def test_experience_reuse_honors_memory_preference_without_private_memory_tools(database):
    d = database
    context = _experience_context(d)
    _experience(d)
    pref = AIMemoryPreference(user_id=d.user.id, enabled=False)
    d.db.add(pref); d.db.commit()
    result = context.recall(d.agents["coordinator"], "")
    assert result == {"experiences":[], "memory_enabled":False}
    pref.enabled = True; d.db.commit()
    assert len(context.recall(d.agents["coordinator"], "")["experiences"]) == 1
    names = {row["name"] for row in context.schemas(d.agents["coordinator"])}
    assert "collaboration_recall" in names
    assert "recall_memory" not in names and "remember_fact" not in names


def test_experience_results_and_queries_are_bounded_and_wildcards_literal(database):
    d = database
    context = _experience_context(d)
    for index in range(7):
        _experience(d, content=f"case-{index}: usage50%_full " + "a"*2500)
    assert len(context.recall(d.agents["coordinator"], "")["experiences"]) == 5
    result = context.recall(d.agents["coordinator"], "50%_full")
    assert len(result["experiences"]) == 5
    assert all(len(row["content"]) <= 2000 for row in result["experiences"])
    assert context.recall(d.agents["coordinator"], "50%_missing")["experiences"] == []
    assert "error" in context.recall(d.agents["coordinator"], "x"*301)
    assert "error" in context.recall(d.agents["coordinator"], {"query":"bad-type"})


def test_persisted_scope_snapshot_blocks_narrowed_board_before_read(database):
    d = database
    context = _experience_context(d)
    d.agents["coordinator"].allowed_hosts = ["restricted-host"]
    d.db.commit()
    # A new process captures the narrowed current scope, but must still reject
    # the board's old broad scope before reading any existing post.
    fresh = Collaboration(d.db, d.task.id, d.agents["coordinator"], d.policy)
    with pytest.raises(CollaborationStopped, match="Board scope changed"):
        fresh.read(d.agents["coordinator"])


def test_legacy_current_board_cannot_reuse_experiences(database):
    d = database
    context = begin(d.db, d.agents["coordinator"], str(d.task.id))
    _experience(d)
    assert context.recall(d.agents["coordinator"], "")["experiences"] == []


def test_experience_post_visible_and_cross_board_reply_rejected(database):
    d = database
    context = _experience_context(d)
    saved = context.post(d.agents["coordinator"], "experience", "Source: synthetic measurement; observed recovery, causal fix unverified")
    assert context.read(d.agents["linux"])[0]["id"] == saved["post_id"]
    question = _experience(d, kind="question", agent="coordinator")
    question.recipient = "linux"; d.db.commit()
    with pytest.raises(CollaborationStopped, match="does not match"):
        context.post(d.agents["linux"], "answer", "invalid", recipient="coordinator", automatic=True, reply_to_id=question.id)


def test_current_board_deleted_participant_blocks_further_reads(database):
    from sqlalchemy import delete
    d = database
    context = _experience_context(d)
    board = d.db.get(Board, d.task.id)
    board.participants = ["coordinator", "linux"]
    d.db.commit()
    d.db.execute(delete(AIAgent).where(AIAgent.id == d.agents["linux"].id)); d.db.commit()
    with pytest.raises(CollaborationStopped, match="no longer available"):
        context.read(d.agents["coordinator"])


@pytest.mark.parametrize("change", ["owner", "source", "lead"])
def test_current_board_trusted_task_consistency_before_reads(database, change):
    d = database
    context = _experience_context(d)
    if change == "owner":
        other = User(username="different-owner", password_hash="test", role="admin")
        d.db.add(other); d.db.flush()
        d.task.owner_user_id = other.id
    elif change == "source":
        d.task.source = "web"
    else:
        d.task.agent_id = d.agents["linux"].id
    d.db.commit()
    with pytest.raises(CollaborationStopped, match="ownership or lead agent changed"):
        context.read(d.agents["coordinator"])
