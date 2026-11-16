import asyncio
import uuid
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock, patch
import pytest


def test_warning_targets_only_bound_active_owner_and_retries_same_key():
    from app.services.ai_budget_watch import poll_once
    owner_id=uuid.uuid4()
    db=AsyncMock()
    db.get.return_value=NS(value={"investigation_owner_user_id":str(owner_id)})
    db.scalar.return_value=NS(id=owner_id)
    ctx=MagicMock()
    ctx.__aenter__=AsyncMock(return_value=db)
    ctx.__aexit__=AsyncMock(return_value=False)
    settings=NS(talk_notifications_enabled=True,talk_memory_bindings=[NS(user_id=owner_id,room_token="private-owner-room"),NS(user_id=uuid.uuid4(),room_token="other-admin-room")])
    budget={"warning":True,"limit_usd":20,"pricing_unknown":0,"billed_usd":16,"reserved_usd":0,"remaining_usd":4,"week_start":"2026-09-21","reset_at":"2026-09-28T00:00:00+00:00"}
    with patch("app.services.ai_budget_watch.async_session_factory",return_value=ctx), patch("app.services.ai_budget_watch.get_settings",return_value=settings), patch("app.services.ai_budget_watch.budget_status",AsyncMock(return_value=budget)), patch("app.services.ai_budget_watch.notify_once",AsyncMock(side_effect=[RuntimeError("network"),True])) as notify:
        with pytest.raises(RuntimeError): asyncio.run(poll_once())
        asyncio.run(poll_once())
    assert notify.await_count == 2
    first,second=notify.await_args_list
    assert first.args[0] == second.args[0]
    assert first.args[1] == second.args[1] == "private-owner-room"
    assert "$16.00" in first.args[2] and "$4.00" in first.args[2]


@pytest.mark.parametrize("warning,has_owner,active_owner,enabled", [(False,True,True,True),(True,False,False,True),(True,True,False,True),(True,True,True,False)])
def test_warning_not_sent_below_threshold_or_without_authorized_room(warning,has_owner,active_owner,enabled):
    from app.services.ai_budget_watch import poll_once
    owner_id=uuid.uuid4()
    db=AsyncMock()
    db.get.return_value=NS(value={"investigation_owner_user_id":str(owner_id)} if has_owner else {})
    db.scalar.return_value=NS(id=owner_id) if active_owner else None
    ctx=MagicMock()
    ctx.__aenter__=AsyncMock(return_value=db)
    ctx.__aexit__=AsyncMock(return_value=False)
    settings=NS(talk_notifications_enabled=enabled,talk_memory_bindings=[NS(user_id=owner_id,room_token="private-owner-room")])
    budget={"warning":warning,"limit_usd":20,"pricing_unknown":0,"billed_usd":16 if warning else 15.99,"reserved_usd":0,"remaining_usd":4,"week_start":"2026-09-21","reset_at":"2026-09-28T00:00:00+00:00"}
    with patch("app.services.ai_budget_watch.async_session_factory",return_value=ctx), patch("app.services.ai_budget_watch.get_settings",return_value=settings), patch("app.services.ai_budget_watch.budget_status",AsyncMock(return_value=budget)), patch("app.services.ai_budget_watch.notify_once",AsyncMock()) as notify:
        asyncio.run(poll_once())
    notify.assert_not_awaited()
    if not has_owner: db.scalar.assert_not_awaited()
