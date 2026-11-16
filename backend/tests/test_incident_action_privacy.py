"""Private IM action listing and current authorization at approval."""
import asyncio
import os
import uuid
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock,MagicMock,patch
import pytest
from sqlalchemy import create_engine,text
from sqlalchemy.orm import Session
from app.models.ai import AIAction,AIAgent,AIProvider,AITask
from app.models.host import Host,Credential
from app.models.user import User
from app.services.action_approval import decide_action
from app.core.action_policy import ActionDenied


def action_fixture():
    owner=NS(id=uuid.uuid4(),username="owner",role="admin",is_active=True)
    parent=NS(id=uuid.uuid4(),source="incident",owner_user_id=owner.id,status="completed")
    action=NS(id=uuid.uuid4(),task_id=parent.id,source="incident",owner_user_id=owner.id,status="pending",
        approval_level=2,expires_at=datetime.now(timezone.utc)+timedelta(minutes=5),arguments={},request_code="ACT-2026-12345678")
    db=MagicMock()
    db.execute=AsyncMock(return_value=NS(scalar_one_or_none=lambda:action))
    db.get=AsyncMock(return_value=parent)
    db.commit=AsyncMock()
    db.refresh=AsyncMock()
    db.run_sync=AsyncMock(side_effect=lambda fn:fn(db))
    return db,owner,parent,action


@pytest.mark.parametrize("approve",[True,False])
def test_other_admin_cannot_decide_private_incident_action(approve):
    db,owner,parent,action=action_fixture()
    other=NS(id=uuid.uuid4(),username="other",role="admin",is_active=True)
    with patch("app.services.action_approval.get_celery_client") as queue, pytest.raises(ActionDenied) as error:
        asyncio.run(decide_action(db,other,action_id=action.id,approve=approve))
    assert error.value.status_code==404 and action.status=="pending"
    db.commit.assert_not_awaited()
    queue.assert_not_called()


def test_revoked_incident_blocks_approval_before_any_state_or_dispatch_change():
    db,owner,parent,action=action_fixture()
    with patch("app.services.action_approval.incident_task_authorized",return_value=False) as check, patch("app.services.action_approval.get_celery_client") as queue, pytest.raises(ActionDenied) as error:
        asyncio.run(decide_action(db,owner,action_id=action.id))
    assert error.value.status_code==403 and action.status=="pending"
    check.assert_called_once_with(db,parent)
    db.commit.assert_not_awaited()
    queue.assert_not_called()


def test_current_owner_can_approve_only_after_sync_authorization_check():
    db,owner,parent,action=action_fixture()
    with patch("app.services.action_approval.incident_task_authorized",return_value=True) as check, patch("app.services.action_approval.get_celery_client") as queue:
        asyncio.run(decide_action(db,owner,action_id=action.id))
    assert action.status=="approved"
    check.assert_called_once_with(db,parent)
    queue.return_value.send_task.assert_called_once()


def test_owner_can_reject_revoked_but_still_pending_incident_action():
    db,owner,parent,action=action_fixture()
    with patch("app.services.action_approval.incident_task_authorized") as check, patch("app.services.action_approval.get_celery_client") as queue:
        asyncio.run(decide_action(db,owner,action_id=action.id,approve=False))
    assert action.status=="rejected"
    check.assert_not_called()
    queue.assert_not_called()


def test_real_postgres_action_listing_hides_incident_arguments_from_other_users():
    from app.api.routes.ai import list_actions
    from app.db.base import Base
    url=os.getenv("AI_BUDGET_TEST_DATABASE_URL")
    if not url: pytest.skip("Dedicated disposable budget database not configured")
    engine=create_engine(url)
    assert engine.url.database=="ops_budget_test"
    schema="action_privacy_"+uuid.uuid4().hex
    with engine.begin() as connection: connection.execute(text(f"CREATE SCHEMA {schema}"))
    scoped=engine.execution_options(schema_translate_map={None:schema})
    try:
        Base.metadata.create_all(scoped,tables=[Credential.__table__,Host.__table__,User.__table__,AIProvider.__table__,AIAgent.__table__,AITask.__table__,AIAction.__table__])
        with Session(scoped,expire_on_commit=False) as db:
            owner=User(username="owner",role="admin",password_hash="unused")
            other=User(username="other",role="admin",password_hash="unused")
            agent=AIAgent(slug="coordinator",name="Coordinator",system_prompt="")
            db.add_all([owner,other,agent]);db.flush()
            task=AITask(agent_id=agent.id,owner_user_id=owner.id,source="incident",input_message="private",status="completed")
            db.add(task);db.flush()
            private=AIAction(agent_id=agent.id,task_id=task.id,owner_user_id=owner.id,source="incident",request_code="ACT-PRIVATE",tool="restart_service",action="Private",arguments={"private":"value"})
            stale=AIAction(agent_id=agent.id,task_id=task.id,owner_user_id=owner.id,source="web",request_code="ACT-STALE",tool="restart_service",action="Private stale source",arguments={"private":"value"})
            public=AIAction(agent_id=agent.id,source="web",request_code="ACT-PUBLIC",tool="restart_service",action="Public",arguments={})
            orphan=AIAction(agent_id=agent.id,source="incident",request_code="ACT-ORPHAN",tool="restart_service",action="Private orphan",arguments={"private":"value"})
            db.add_all([private,stale,public,orphan]);db.commit()
            adapter=NS(execute=AsyncMock(side_effect=lambda query:db.execute(query)))
            assert {a.id for a in asyncio.run(list_actions(db=adapter,current_user=other,limit=50))}=={public.id}
            assert {a.id for a in asyncio.run(list_actions(db=adapter,current_user=owner,limit=50))}=={private.id,stale.id,public.id}
            assert asyncio.run(list_actions(db=adapter,current_user=other,task_id=task.id,limit=50))==[]
    finally:
        with engine.begin() as connection: connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        engine.dispose()
