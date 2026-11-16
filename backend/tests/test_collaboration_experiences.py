"""Owned experience archive and paid-board admission against a disposable database."""
import os,uuid
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
import pytest,pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import select,func,text
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from sqlalchemy.pool import NullPool
from app.api.routes import ai_collaboration as api
from app.models.ai import AIAgent,AIProvider,AITask
from app.models.ai_collaboration import AICollaborationSettings as Settings,AICollaborationBoard as Board,AICollaborationPost as Post
from app.models.ai_budget import AIBudgetWeek
from app.models.ai_memory import AIMemoryPreference
from app.models.user import User
from app.schemas.ai import AskRequest
from app.schemas.ai_collaboration import CollaborationPolicy,AgentPermissions
from app.services.ai_budget import week_start

URL=os.getenv("OPS_COLLAB_API_TEST_URL", "")
pytestmark=pytest.mark.skipif(not URL,reason="Dedicated collaboration API database not configured")

@pytest_asyncio.fixture
async def env(monkeypatch):
    assert URL.split("?")[0].rsplit("/",1)[-1]=="ops_collaboration_api_test", "Refusing application database"
    engine=create_async_engine(URL,poolclass=NullPool)
    factory=async_sessionmaker(engine,expire_on_commit=False)
    async with factory() as db:
        await db.execute(text("TRUNCATE ai_collaboration_posts, ai_collaboration_boards, ai_tasks, ai_agents, ai_providers, users, ai_budget_weeks CASCADE"))
        owner=User(username="owner",password_hash="test",role="admin",is_active=True)
        other=User(username="other",password_hash="test",role="admin",is_active=True)
        provider=AIProvider(slug="test",kind="openai",display_name="Synthetic",enabled=True,default_model="gpt-5.6-luna")
        db.add_all([owner,other,provider]);await db.flush()
        agent=AIAgent(slug="coordinator",name="Coordinator",provider_id=provider.id,model="gpt-5.6-luna",enabled=True,system_prompt="",allowed_tools=[],allowed_hosts=["b.example","a.example","a.example"],allowed_environments=["test"])
        db.add(agent);await db.flush()
        policy=CollaborationPolicy(enabled=True,agents={"coordinator":AgentPermissions()})
        settings=await db.get(Settings,1)
        settings.policy=policy.model_dump();settings.revision=1
        await db.commit()
    broker=MagicMock();monkeypatch.setattr(api,"get_celery_client",lambda:broker)
    async def board(user=None,status="completed",kind="experience",content="Verified 100% return route",source="collaboration"):
        async with factory() as db:
            user=user or owner
            task=AITask(agent_id=agent.id,owner_user_id=user.id,requested_by=user.username,source=source,status=status,input_message="Return route review")
            db.add(task);await db.flush()
            row=Board(task_id=task.id,owner_user_id=user.id,policy=policy.model_dump(),participants=[agent.slug],requests=[],status=status,message_count=1,expires_at=datetime.now(timezone.utc)+timedelta(minutes=5))
            post=Post(task_id=task.id,sequence=1,agent=agent.slug,kind=kind,content=content)
            db.add_all([row,post]);await db.commit()
            return row,post
    yield SimpleNamespace(db=factory,owner=owner,other=other,agent=agent,provider=provider,broker=broker,board=board)
    await engine.dispose()

@pytest.mark.asyncio
async def test_experience_archive_is_owned_completed_and_searches_literal_text(env):
    own,post=await env.board()
    await env.board(env.other)
    await env.board(kind="hypothesis")
    await env.board(status="running")
    await env.board(source="web")
    await env.board(content="No percent sign")
    async with env.db() as db:
        result=await api.experiences(q="%",limit=30,db=db,user=env.owner)
        assert [row["id"] for row in result["items"]]==[post.id]
        assert result["items"][0]["task_id"]==own.task_id
        assert result["items"][0]["question"]=="Return route review"
        assert result["memory_enabled"]
        result=await api.experiences(q="",limit=30,db=db,user=env.owner)
        assert len(result["items"])==2

@pytest.mark.asyncio
async def test_memory_optout_preserves_human_archive_and_reports_paused_reuse(env):
    await env.board()
    async with env.db() as db:
        db.add(AIMemoryPreference(user_id=env.owner.id,enabled=False));await db.commit()
        result=await api.experiences(q="",limit=30,db=db,user=env.owner)
        assert result["memory_enabled"] is False and len(result["items"])==1

@pytest.mark.asyncio
async def test_start_snapshots_scope_without_modifying_agent_permissions(env):
    async with env.db() as db:
        result=await api.start(AskRequest(agent="coordinator",message="Compare return route evidence"),db=db,user=env.owner)
        board=await db.get(Board,result["task_id"])
        assert board.scope_snapshot=={"allowed_hosts":["a.example","b.example"],"allowed_environments":["test"]}
        assert board.owner_user_id==env.owner.id
        assert (await db.get(AIAgent,env.agent.id)).allowed_hosts==["b.example","a.example","a.example"]
        env.broker.send_task.assert_called_once()

@pytest.mark.asyncio
@pytest.mark.parametrize("condition,status",[("exhausted",402),("unknown",409),("disabled",422),("missing_model",422)])
async def test_paid_admission_stops_before_creating_or_dispatching_a_board(env,condition,status):
    async with env.db() as db:
        if condition=="exhausted": db.add(AIBudgetWeek(week_start=week_start(),initialized=True,billed_usd=20,reserved_usd=0,unpriced_calls=0))
        elif condition=="unknown": (await db.get(AIAgent,env.agent.id)).model="unreviewed-synthetic-model"
        elif condition=="missing_model":
            (await db.get(AIAgent,env.agent.id)).model=None
            (await db.get(AIProvider,env.provider.id)).default_model=None
        else: (await db.get(AIProvider,env.provider.id)).enabled=False
        await db.commit()
        with pytest.raises(HTTPException) as error:
            await api.start(AskRequest(agent="coordinator",message="Synthetic admission check"),db=db,user=env.owner)
        assert error.value.status_code==status
        assert await db.scalar(select(func.count()).select_from(Board))==0
        assert await db.scalar(select(func.count()).select_from(AITask))==0
        env.broker.send_task.assert_not_called()

@pytest.mark.asyncio
async def test_detail_returns_exact_question_link_but_hides_other_owners(env):
    board,question=await env.board(kind="question",content="Which return route is verified?")
    async with env.db() as db:
        reply=Post(task_id=board.task_id,sequence=2,agent="linux",recipient="coordinator",kind="answer",content="No current observation supplied.",reply_to_id=question.id)
        db.add(reply);await db.commit()
        detail=await api.detail(board.task_id,db=db,user=env.owner)
        assert detail["posts"][1]["reply_to_id"]==question.id
        with pytest.raises(HTTPException) as error:
            await api.detail(board.task_id,db=db,user=env.other)
        assert error.value.status_code==404


@pytest.mark.asyncio
async def test_workspace_detail_uses_task_records_without_global_activity_or_invented_tool_data(env):
    board, _ = await env.board()
    started = datetime(2026, 9, 22, 0, 0, tzinfo=timezone.utc)
    completed = started + timedelta(seconds=19)
    tools = [{"tool": "get_server_metrics", "arguments": {"hostname": "a.example"}},
             {"tool": "collaboration_ask", "arguments": {"agent": "linux", "question": "Verify the metric source"}}]
    async with env.db() as db:
        task = await db.get(AITask, board.task_id)
        task.started_at, task.completed_at = started, completed
        task.tools_used, task.data_sources = tools, ["Prometheus", "Task collaboration board"]
        task.confidence, task.response_message = 0, "Synthetic recorded conclusion; cause remains unverified."
        # Concurrent agent state and participant ordering do not identify this task's lead or tools.
        agent = await db.get(AIAgent, env.agent.id)
        agent.current_task, agent.status = "A different concurrent investigation", "working"
        (await db.get(Board, board.task_id)).participants = ["linux", "coordinator"]
        await db.commit()
        result = await api.detail(board.task_id, db=db, user=env.owner)
        assert result["lead_agent"] == "coordinator"
        assert result["task_started_at"] == started and result["task_completed_at"] == completed
        assert result["tool_executions"] == tools
        assert all(set(call) == {"tool", "arguments"} for call in result["tool_executions"])
        assert result["data_sources"] == ["Prometheus", "Task collaboration board"]
        assert result["confidence"] == 0
        assert result["response_message"] == task.response_message
        assert "A different concurrent investigation" not in str(result)
        with pytest.raises(HTTPException) as denied:
            await api.detail(board.task_id, db=db, user=env.other)
        assert denied.value.status_code == 404


@pytest.mark.asyncio
async def test_workspace_summary_is_owned_and_queued_details_preserve_unknown_values(env):
    own, _ = await env.board(status="queued")
    await env.board(user=env.other, content="PRIVATE_OTHER_OWNER")
    async with env.db() as db:
        rows = await api.boards(offset=0, limit=30, db=db, user=env.owner)
        assert len(rows) == 1 and rows[0]["board"]["task_id"] == own.task_id
        assert rows[0]["lead_agent"] == "coordinator"
        assert rows[0]["task_started_at"] is None and rows[0]["task_completed_at"] is None
        assert "response_message" not in rows[0] and "tool_executions" not in rows[0]
        result = await api.detail(own.task_id, db=db, user=env.owner)
        assert result["tool_executions"] == [] and result["data_sources"] == []
        assert result["confidence"] is None and result["response_message"] is None
        assert result["task_started_at"] is None and result["task_completed_at"] is None
