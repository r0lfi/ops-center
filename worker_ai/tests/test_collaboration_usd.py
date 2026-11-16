"""Collaboration uses the real USD ledger; only the provider itself is fake.

Each test gets a separate schema in the disposable ops_budget_test database,
so existing collaboration/budget fixtures cannot leave cross-test FKs behind.
"""
import os
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace as NS
from unittest.mock import patch
import pytest
from sqlalchemy import create_engine, select, func, text
from sqlalchemy.orm import Session
from app.db.base import Base
from app.models.ai import AIProvider, AIAgent, AITask, AIUsage
from app.models.user import User
from app.models.audit import AuditLogEntry
from app.models.ai_memory import AIMemoryPreference
from app.models.ai_budget import AIBudgetWeek as Week, AIBudgetReservation as USDReservation, AIBudgetSettings
from app.models.ai_collaboration import (
    AICollaborationSettings as Settings, AICollaborationBoard as Board,
    AICollaborationPost as Post, AICollaborationDailyUsage as Daily,
    AICollaborationReservation as TokenReservation,
)
from app.schemas.ai_collaboration import CollaborationPolicy, AgentPermissions
from app.services.ai_budget import week_start
from worker_ai.ai.collaboration import begin, now
from worker_ai.ai.providers.base import ProviderResult, ProviderError, ToolCall
from worker_ai.ai.runtime import run_agent

TABLES = [User.__table__, AIProvider.__table__, AIAgent.__table__, AITask.__table__, AIUsage.__table__,
          AuditLogEntry.__table__, AIMemoryPreference.__table__, Week.__table__, USDReservation.__table__, AIBudgetSettings.__table__,
          Settings.__table__, Board.__table__, Post.__table__, Daily.__table__, TokenReservation.__table__]


@pytest.fixture
def database():
    url = os.getenv("AI_BUDGET_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Dedicated weekly budget PostgreSQL database not configured")
    engine = create_engine(url)
    assert engine.url.database == "ops_budget_test", "Refusing to modify any other database"
    schema = "collab_usd_" + uuid.uuid4().hex
    with engine.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA {schema}"))
    scoped = engine.execution_options(schema_translate_map={None: schema})
    try:
        Base.metadata.create_all(scoped, tables=TABLES)
        with Session(scoped, expire_on_commit=False) as db:
            owner = User(username="owner", role="admin", password_hash="unused")
            provider = AIProvider(slug="paid-test", kind="anthropic", display_name="Paid fake", default_model="claude-sonnet-5", enabled=True)
            db.add_all([owner, provider]); db.flush()
            agents = {}
            for slug in ("coordinator", "linux", "network"):
                agent = AIAgent(slug=slug, name=slug, provider_id=provider.id, model="claude-sonnet-5", enabled=True,
                    system_prompt="Agent identity: " + slug, allowed_tools=[], allowed_hosts=[], allowed_environments=[],
                    max_tool_calls=64, max_execution_seconds=300)
                db.add(agent); agents[slug] = agent
            db.flush()
            policy = CollaborationPolicy(enabled=True, max_tokens=600000, max_daily_tokens=4000000,
                max_model_calls=64, max_messages=128,
                agents={slug: AgentPermissions(peers=[p for p in agents if p != slug]) for slug in agents})
            db.add(Settings(id=1, revision=1, policy=policy.model_dump()))
            task = AITask(agent_id=agents["coordinator"].id, owner_user_id=owner.id, requested_by=owner.username,
                source="collaboration", input_message="Check the return route using specialist evidence", status="running")
            db.add(task); db.flush()
            db.add(Board(task_id=task.id, owner_user_id=owner.id, policy=policy.model_dump(), participants=["coordinator"],
                requests=[], status="queued", expires_at=now()+timedelta(minutes=5)))
            db.commit()
            yield NS(db=db, task=task, owner=owner, agents=agents)
    finally:
        with engine.begin() as connection:
            connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()


class PaidProvider:
    def __init__(self, *, fail=False, unknown=False):
        self.calls=[]
        self.counts={}
        self.fail, self.unknown = fail, unknown

    def chat(self, **kwargs):
        slug=kwargs["system"].splitlines()[0].removeprefix("Agent identity: ")
        self.calls.append(slug)
        if self.fail:
            raise ProviderError("Uncertain provider timeout")
        count=self.counts.get(slug,0)
        self.counts[slug]=count+1
        usage={"input_tokens":0 if self.unknown else 100,"output_tokens":0 if self.unknown else 60,"usage_reported":not self.unknown}
        if count==0 and slug != "network" and not self.unknown:
            peer="linux" if slug=="coordinator" else "network"
            return ProviderResult(text="", stop_reason="tool_use", tool_calls=[ToolCall("ask-"+slug,"collaboration_ask",{"agent":peer,"question":"Check return route for "+peer})],
                assistant_message={"role":"assistant","content":"Request route check"}, **usage)
        return ProviderResult(text=slug+": completed read-only route checks", assistant_message={"role":"assistant","content":"Read-only route evidence"}, **usage)

    def tool_result_messages(self,calls,results):
        return [{"role":"tool","content":result} for result in results]


def run(d, provider):
    # Do not mock reserve_usd, settle_usd, token accounting, or board logic.
    with patch("worker_ai.ai.runtime.build_provider",return_value=provider), patch("worker_ai.ai.runtime.set_agent_state"), patch("worker_ai.ai.agent_state.set_agent_state"):
        return run_agent(d.db,d.agents["coordinator"],d.task.input_message,task_id=str(d.task.id))


def test_three_paid_agents_settle_five_calls_into_one_global_week(database):
    d=database
    provider=PaidProvider()
    result=run(d,provider)
    reservations=list(d.db.scalars(select(USDReservation)))
    assert provider.calls==["coordinator","linux","network","linux","coordinator"]
    assert len(reservations)==5 and {r.task_id for r in reservations}=={d.task.id}
    assert {r.agent_id for r in reservations}=={a.id for a in d.agents.values()}
    assert {r.week_start for r in reservations}=={week_start()}
    assert all(r.status=="settled" and r.billed_usd==Decimal("0.0008") for r in reservations)
    week=d.db.get(Week,week_start())
    assert week.billed_usd==Decimal("0.004") and week.reserved_usd==0
    assert d.db.get(Board,d.task.id).status=="completed"
    assert d.db.get(Board,d.task.id).model_calls==5
    assert set(result.agents_used)==set(d.agents)
    assert d.db.scalar(select(func.count()).select_from(AIUsage))==5


def test_denied_helper_releases_unstarted_tokens_and_preserves_earlier_evidence(database):
    d=database
    d.agents["linux"].model="claude-opus-4-20250514"
    d.db.add(Week(week_start=week_start(),initialized=True,billed_usd=Decimal("19.90"),reserved_usd=0,unpriced_calls=0))
    board=d.db.get(Board,d.task.id)
    board.message_count=1
    d.db.add(Post(task_id=d.task.id,sequence=1,agent="coordinator",kind="evidence",content="Earlier observed gateway responded to the read-only probe."))
    d.db.commit()
    provider=PaidProvider()
    result=run(d,provider)
    d.db.expire_all()
    assert provider.calls==["coordinator"]  # expensive helper never reached the provider
    assert "Earlier observed gateway" in result.text and "weekly AI budget" in result.text
    board=d.db.get(Board,d.task.id)
    assert board.status=="stopped" and board.model_calls==1
    reservations=list(d.db.scalars(select(TokenReservation)))
    assert sorted(r.status for r in reservations)==["released","settled"]
    assert next(r for r in reservations if r.status=="released").charged_tokens==0
    assert board.charged_tokens==sum(r.charged_tokens for r in reservations)
    assert d.db.get(Daily,now().date()).charged_tokens==board.charged_tokens
    assert d.db.scalar(select(func.count()).select_from(USDReservation))==1
    assert d.db.get(Week,week_start()).billed_usd==Decimal("19.9008")
    assert d.db.get(Week,week_start()).reserved_usd==0


def test_known_unstarted_token_release_is_idempotent(database):
    d=database
    context=begin(d.db,d.agents["coordinator"],str(d.task.id))
    reservation,_=context.reserve(d.agents["coordinator"],"No provider called",[],[])
    context.release_reservation(reservation)
    context.release_reservation(reservation)
    assert d.db.get(Board,d.task.id).model_calls==0
    assert d.db.get(Board,d.task.id).charged_tokens==0
    assert d.db.get(Daily,now().date()).charged_tokens==0
    assert d.db.get(TokenReservation,reservation).status=="released"


@pytest.mark.parametrize("failure",["timeout","missing_usage"])
def test_uncertain_provider_attempt_never_refunds_any_reservation(database,failure):
    d=database
    provider=PaidProvider(fail=failure=="timeout",unknown=failure=="missing_usage")
    if failure=="timeout":
        with pytest.raises(ProviderError): run(d,provider)
    else:
        run(d,provider)
    d.db.expire_all()
    tokens=d.db.scalar(select(TokenReservation))
    dollars=d.db.scalar(select(USDReservation))
    assert provider.calls==["coordinator"]
    assert tokens.status in ("reserved","unknown") and tokens.charged_tokens>0
    assert dollars.status in ("reserved","unknown") and dollars.reserved_usd>0
    assert d.db.get(Board,d.task.id).model_calls==1
    assert d.db.get(Week,week_start()).reserved_usd==dollars.reserved_usd
    assert d.db.get(Week,week_start()).billed_usd==0
