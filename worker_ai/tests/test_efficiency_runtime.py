import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

import pytest

from app.models.ai import AIAgent, AITask
from app.models.user import User
from app.models.mcp import MCPClient, MCPGrant, MCPSettings
from worker_ai.ai import runtime as r
from worker_ai.ai.providers.base import ProviderResult, ProviderError, ProviderCallNotStarted, ToolCall


def agent(slug, tools=()):
    return NS(id=uuid.uuid4(), slug=slug, name=slug, enabled=True,
              provider=NS(enabled=True, kind="ollama", default_model=slug), model=slug,
              provider_id=uuid.uuid4(), allowed_tools=list(tools), allowed_hosts=[],
              allowed_environments=[], system_prompt="Investigate", max_tool_calls=8,
              max_execution_seconds=30)


@pytest.fixture
def delegation(monkeypatch):
    caller=agent("coordinator", [r.DISPATCH_TOOL_NAME])
    target=agent("linux")
    owner=NS(id=uuid.uuid4(), role="admin", is_active=True)
    task=NS(id=uuid.uuid4(), owner_user_id=owner.id, source="web", status="running")
    db=MagicMock()
    grant=NS(id=uuid.uuid4(), resource="https://ops.example/mcp", expires_at=datetime.now(timezone.utc)+timedelta(hours=1),
             revoked_at=None, scopes=["read"], allowed_tools=[])
    client=NS(id="test", enabled=True, scopes=["read"], allowed_tools=[], allowed_user_ids=[str(owner.id)])
    grant.client_id=client.id
    state=NS(enabled=True, revision=1)
    agents={caller.id:caller, target.id:target}
    def get(model, key, **kwargs):
        if model is AIAgent: return agents.get(key)
        if model is AITask: return task
        if model is User: return owner
        if model is MCPSettings: return state
        if model is MCPClient: return client
        return None
    def execute(query):
        entity=query.column_descriptions[0]["entity"]
        if entity is MCPGrant:
            assert "revoked_at IS NULL" in str(query) and "expires_at >" in str(query)
            current=[grant] if grant.revoked_at is None and grant.expires_at>datetime.now(timezone.utc) else []
            return NS(scalars=lambda:current)
        return NS(scalar_one_or_none=lambda:task.status)
    db.get.side_effect=get
    db.execute.side_effect=execute
    monkeypatch.setattr(r, "memory_owner", lambda *args:owner.id)
    monkeypatch.setattr(r, "set_agent_state", MagicMock())
    run=MagicMock(return_value=r.RunResult("Observed healthy service", tools_used=[{"tool":"get_alerts","arguments":{}}]))
    monkeypatch.setattr(r, "run_agent", run)
    scoped=r._DelegationRun(str(task.id), active=[str(caller.id)])
    token=r._DELEGATIONS.set(scoped)
    env=NS(caller=caller,target=target,owner=owner,task=task,db=db,run=run,grant=grant,client=client,state=state,scoped=scoped)
    env.ask=lambda question="Check nginx":r._dispatch(db,caller,target,question,str(task.id),0)
    yield env
    r._DELEGATIONS.reset(token)


def test_completed_dispatch_reuses_exact_request_and_preserves_case(delegation):
    e=delegation
    assert e.ask(" Check nginx ")[2] is False
    output,result,reused=e.ask("Check nginx")
    assert reused and output["reused"] and result.text=="Observed healthy service"
    e.run.assert_called_once()
    assert e.ask("Check NGINX")[2] is False
    assert e.run.call_count==2


@pytest.mark.parametrize("change", ["target_disabled", "dispatch_revoked", "cancelled", "owner_inactive"])
def test_authority_is_rechecked_before_every_cache_hit(delegation, change):
    e=delegation; e.ask()
    if change=="target_disabled": e.target.enabled=False
    elif change=="dispatch_revoked": e.caller.allowed_tools=[]
    elif change=="cancelled": e.task.status="cancelled"
    else: e.owner.is_active=False
    if change in ("cancelled","owner_inactive"):
        with pytest.raises(r.TaskCancelled): e.ask()
    else:
        output,result,reused=e.ask()
        assert output.get("error") and result is None and not reused
    e.run.assert_called_once()


@pytest.mark.parametrize("change", ["hosts", "tools", "owner_role", "grant_revoked", "grant_expired", "client_revoked"])
def test_changed_effective_scope_never_reuses_earlier_answer(delegation, change):
    e=delegation
    if change.startswith("grant") or change=="client_revoked":
        tool=next(iter(r.MCP_SCHEMAS)); e.target.allowed_tools=[tool]
        e.grant.allowed_tools=[tool]; e.client.allowed_tools=[tool]
    e.ask()
    if change=="hosts": e.target.allowed_hosts=["restricted-host"]
    elif change=="tools": e.target.allowed_tools=["get_alerts"]
    elif change=="owner_role": e.owner.role="viewer"
    elif change=="grant_revoked": e.grant.revoked_at=datetime.now(timezone.utc)
    elif change=="grant_expired": e.grant.expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)
    else: e.client.enabled=False
    assert e.ask()[2] is False
    assert e.run.call_count==2


def test_partial_results_are_not_cached_and_cycles_do_not_start_agent(delegation):
    e=delegation; e.run.return_value=r.RunResult("Partial observation", partial=True)
    e.ask(); e.ask()
    assert e.run.call_count==2 and not e.scoped.completed
    e.scoped.active.append(str(e.target.id))
    assert "Circular" in e.ask()[0]["error"]
    assert e.run.call_count==2


def test_dispatch_cache_cannot_cross_task_run_or_owner(delegation):
    e=delegation; e.ask()
    output,_,reused=r._dispatch(e.db,e.caller,e.target,"Check nginx",str(uuid.uuid4()),0)
    assert output.get("error") and not reused
    e.task.owner_user_id=uuid.uuid4()
    assert e.ask()[2] is False
    assert e.run.call_count==2


def test_permission_change_during_specialist_run_does_not_publish_or_cache_result(delegation):
    e=delegation
    def narrow(*args,**kwargs):
        e.target.allowed_hosts=["narrowed"]
        return r.RunResult("Earlier broad observation")
    e.run.side_effect=narrow
    output,result,reused=e.ask()
    assert output.get("error") and result is None and not reused
    assert not e.scoped.completed


@pytest.fixture
def loop(monkeypatch):
    db=MagicMock(); db.get.return_value=None
    db.execute.return_value.scalar_one_or_none.return_value=None
    a=agent("linux", ["get_alerts"])
    provider=MagicMock()
    provider.tool_result_messages.side_effect=lambda calls,results:[{"role":"user","content":json.dumps(results)}]
    monkeypatch.setattr(r,"build_provider",lambda _:provider)
    monkeypatch.setattr(r,"memory_owner",lambda *args:None)
    monkeypatch.setattr(r,"note_context",lambda *args,**kwargs:"")
    monkeypatch.setattr(r,"set_agent_state",MagicMock())
    monkeypatch.setattr(r,"_safe_read",MagicMock(return_value={"available":True,"count":2}))
    reserve=MagicMock(return_value=None); settle=MagicMock(); usage=MagicMock(); release=MagicMock()
    monkeypatch.setattr(r,"reserve_usd",reserve); monkeypatch.setattr(r,"settle_usd",settle)
    monkeypatch.setattr(r,"_record_usage",usage); monkeypatch.setattr(r,"release_unattempted",release)
    return NS(db=db,agent=a,provider=provider,reserve=reserve,settle=settle,usage=usage,release=release)


def tool_result(*calls):
    return ProviderResult(text="", tool_calls=list(calls), stop_reason="tool_use", assistant_message={"role":"assistant","content":""},
                          input_tokens=10,output_tokens=5,usage_reported=True)


def alert(ident="one"):
    return ToolCall(id=ident,name="get_alerts",arguments={})


def test_tool_limit_keeps_prior_paid_evidence_and_does_not_run_next_tool(loop):
    e=loop;e.agent.max_tool_calls=1
    e.provider.chat.side_effect=[tool_result(alert()),tool_result(alert("two"))]
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and "Partial investigation" in result.text and '"count": 2' in result.text
    assert len(result.tools_used)==1 and result.data_sources==["Alertmanager"]
    assert e.provider.chat.call_count==2 and e.usage.call_count==2
    r._safe_read.assert_called_once()


def test_deadline_keeps_paid_evidence_without_summary_call(loop,monkeypatch):
    e=loop;e.provider.chat.return_value=tool_result(alert())
    checks=0
    def deadline():
        nonlocal checks
        checks+=1
        if checks>=5: raise r.TaskBudgetExceeded("Time budget reached")
    monkeypatch.setattr(r,"_check_deadline",deadline)
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and '"count": 2' in result.text and result.tools_used
    e.provider.chat.assert_called_once()
    assert r._DELEGATIONS.get() is None


@pytest.mark.parametrize("reason", ["max_tokens","length"])
def test_truncated_paid_text_is_partial_without_retry(loop,reason):
    e=loop;e.provider.chat.return_value=ProviderResult(text="Useful paid finding",stop_reason=reason,assistant_message={"role":"assistant","content":"Useful paid finding"})
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and "Useful paid finding" in result.text and "output limit" in result.stop_reason
    e.provider.chat.assert_called_once()


def test_known_unattempted_provider_call_releases_and_keeps_prior_evidence(loop):
    e=loop;reservation=NS(id=uuid.uuid4());e.reserve.return_value=reservation
    e.provider.chat.side_effect=[tool_result(alert()),ProviderCallNotStarted("Deadline reached before HTTP")]
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and result.tools_used and '"count": 2' in result.text
    e.release.assert_called_once_with(e.db,reservation)
    assert e.settle.call_count==1 and e.usage.call_count==1 and e.provider.chat.call_count==2


def test_malformed_paid_response_is_accounted_before_error_with_no_tool_execution(loop):
    e=loop;reservation=NS(id=uuid.uuid4());e.reserve.return_value=reservation
    e.provider.chat.return_value=ProviderResult(text="",input_tokens=123,output_tokens=45,usage_reported=True,
        error_message="Malformed tool response",cache_write_tokens=None,cache_write_1h_tokens=None)
    events=[]
    e.settle.side_effect=lambda *args,**kwargs:events.append("settled")
    e.usage.side_effect=lambda *args,**kwargs:events.append("recorded")
    with pytest.raises(ProviderError,match="Malformed"): r.run_agent(e.db,e.agent,"Check host")
    assert events==["settled","recorded"]
    assert e.usage.call_args.kwargs["reservation_id"]==reservation.id
    assert e.settle.call_args.kwargs["cache_write"] is None
    e.release.assert_not_called();r._safe_read.assert_not_called();e.provider.chat.assert_called_once()


def test_uncertain_provider_failure_keeps_reservation(loop):
    e=loop;e.reserve.return_value=NS(id=uuid.uuid4())
    e.provider.chat.side_effect=ProviderError("Network outcome unknown")
    with pytest.raises(ProviderError):r.run_agent(e.db,e.agent,"Check host")
    e.release.assert_not_called();e.settle.assert_not_called();e.usage.assert_not_called()


def test_collaboration_partial_output_is_stopped_not_completed(loop,monkeypatch):
    e=loop;board=MagicMock();board.policy.max_seconds=30;board.policy.max_depth=2;board.stack=[]
    monkeypatch.setattr(r,"begin_collaboration",lambda *args:board)
    monkeypatch.setattr(r,"_run_agent",lambda *args,**kwargs:r.RunResult("Partial paid text",partial=True,stop_reason="Provider output limit reached"))
    result=r.run_agent(e.db,e.agent,"Check host")
    board.answer.assert_called_once_with(e.agent,"Partial paid text")
    board.finish.assert_called_once_with("stopped","Provider output limit reached")
    assert result.partial


@pytest.mark.parametrize("category,rule,title,expects_resource", [
    ("traffic","path_scan","Path scan",False), ("disk","disk_capacity","Disk pressure",True),
    ("memory","memory","High memory",True)])
def test_im_routines_use_incident_facts_not_boilerplate(loop,monkeypatch,category,rule,title,expects_resource):
    from worker_ai.ai.skills import task_routines
    e=loop
    task=NS(source="incident",id=uuid.uuid4(),owner_user_id=None,input_message="Use recall_memory; do not perform disk cleanup")
    e.db.get.side_effect=lambda model,*args,**kwargs:task if model is AITask else None
    e.db.scalar.return_value=NS(category=category,rule=rule,title=title,resource="host",details={})
    e.provider.chat.return_value=ProviderResult(text="Done",assistant_message={"role":"assistant","content":"Done"})
    r.run_agent(e.db,e.agent,"Prior discussion about disk and memory",task_id=str(task.id))
    system=e.provider.chat.call_args.kwargs["system"]
    assert ("Resource diagnosis v1" in system) is expects_resource


def test_partial_worker_result_persists_text_trace_sources_and_reason(monkeypatch):
    from worker_ai import tasks
    db=MagicMock();a=agent("linux")
    task=NS(id=uuid.uuid4(),source="web",status="queued",agent=a,conversation_key=None,input_message="Check host",started_at=None)
    db.execute.return_value.scalar_one_or_none.return_value=task
    monkeypatch.setattr(tasks,"SessionLocal",lambda:db)
    db.__enter__.return_value=db
    monkeypatch.setattr(tasks,"_build_contextual_message",lambda *args:"Check host")
    monkeypatch.setattr(tasks,"run_agent",lambda *args,**kwargs:r.RunResult("Partial investigation: time limit",[{"tool":"get_alerts","arguments":{}}],["linux"],["Alertmanager"],True,"Time limit"))
    tasks._run_agent_task(str(task.id),"celery-id")
    assert task.response_message=="Partial investigation: time limit"
    assert task.tools_used and task.data_sources==["Alertmanager"] and task.error_message=="Time limit"
    assert task.completed_at


def test_top_level_run_clears_and_never_reuses_previous_run_cache(loop,monkeypatch):
    e=loop;states=[]
    def inner(*args,**kwargs):
        state=r._DELEGATIONS.get()
        assert not state.completed
        states.append(state)
        state.completed["old-request"]=r.RunResult("Private earlier answer")
        return r.RunResult("Done")
    monkeypatch.setattr(r,"_run_agent",inner)
    r.run_agent(e.db,e.agent,"First request")
    assert r._DELEGATIONS.get() is None
    r.run_agent(e.db,e.agent,"Second request")
    assert r._DELEGATIONS.get() is None and states[0] is not states[1]


def test_empty_provider_response_keeps_prior_paid_observations(loop):
    e=loop;e.provider.chat.side_effect=[tool_result(alert()),ProviderResult(text="",assistant_message={"role":"assistant","content":""})]
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and '"count": 2' in result.text and len(result.tools_used)==1
    assert e.provider.chat.call_count==2


@pytest.mark.parametrize("exception", [r.AIBudgetStopped("Dollars exhausted"),r.CollaborationStopped("Board revoked"),r.TaskBudgetExceeded("Time limit")])
def test_collaboration_control_stop_returns_partial_with_reason(loop,monkeypatch,exception):
    e=loop;board=MagicMock();board.policy.max_seconds=30;board.stack=[]
    board.agents_used={e.agent.slug};board.partial.return_value="Partial board evidence"
    monkeypatch.setattr(r,"begin_collaboration",lambda *args:board)
    monkeypatch.setattr(r,"_run_agent",MagicMock(side_effect=exception))
    result=r.run_agent(e.db,e.agent,"Check host")
    assert result.partial and result.stop_reason==str(exception) and result.text=="Partial board evidence"
    board.finish.assert_called_once_with("stopped",str(exception))
