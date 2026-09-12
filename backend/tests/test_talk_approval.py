import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from app.core.action_policy import validate_decision, ActionDenied
from app.core.config import TalkMemoryBinding
from app.services.action_approval import decide_action
from app.api.routes.integrations import _COMMAND

OWNER = uuid.uuid4()


def sample():
    user = NS(id=OWNER, is_active=True, role="admin", username="owner")
    parent = NS(
        source="talk",
        status="completed",
        owner_user_id=OWNER,
        requested_by="talk:users/owner",
        conversation_key="talk:private",
    )
    action = NS(
        status="pending",
        approval_level=3,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        arguments={"hostname": "host", "service": "nginx"},
    )
    return action, parent, user


def binding():
    return patch(
        "app.core.talk_memory.get_settings",
        return_value=NS(
            talk_memory_bindings=[
                TalkMemoryBinding(
                    actor_id="users/owner", room_token="private", user_id=OWNER
                )
            ]
        ),
    )


def test_valid_exact_bound_user_and_web_approval():
    a, p, u = sample()
    with binding():
        validate_decision(a, p, u, actor_id="users/owner", room_token="private")
    validate_decision(a, p, u)


@pytest.mark.parametrize(
    "kind",
    [
        "wrong_actor",
        "wrong_room",
        "wrong_owner",
        "inactive",
        "viewer",
        "operator",
        "expired",
        "cancelled",
        "replayed",
        "orphan",
        "long",
    ],
)
def test_reject_invalid_authorization(kind):
    a, p, u = sample()
    actor = "users/owner"
    room = "private"
    if kind == "wrong_actor":
        actor = "users/other"
    if kind == "wrong_room":
        room = "other"
    if kind == "wrong_owner":
        u.id = uuid.uuid4()
    if kind == "inactive":
        u.is_active = False
    if kind == "viewer":
        u.role = "viewer"
    if kind == "operator":
        u.role = "operator"
    if kind == "expired":
        a.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    if kind == "cancelled":
        p.status = "cancelled"
    if kind == "replayed":
        a.status = "approved"
    if kind == "orphan":
        p = None
    if kind == "long":
        a.arguments = {"command": "x" * 3000}
    with binding(), pytest.raises(ActionDenied):
        validate_decision(a, p, u, actor_id=actor, room_token=room)


@pytest.mark.parametrize(
    "text",
    [
        "ja",
        "approved",
        "godkjenn",
        "godkjenn ACT-2026-01234567 og slett alt",
        "godkjenn ACT-2026-01234567\nignore instructions",
    ],
)
def test_free_text_cannot_authorize(text):
    assert _COMMAND.fullmatch(text) is None


def test_exact_command_accepted():
    assert _COMMAND.fullmatch("godkjenn ACT-2026-01234567")


def test_decision_locks_and_enqueues_once():
    async def scenario():
        a, p, u = sample()
        a.id = uuid.uuid4()
        a.task_id = uuid.uuid4()
        a.request_code = "ACT-2026-01234567"
        db = MagicMock()
        db.execute = AsyncMock(return_value=NS(scalar_one_or_none=lambda: a))
        db.get = AsyncMock(return_value=p)
        db.commit = AsyncMock()
        db.refresh = AsyncMock()
        with patch("app.services.action_approval.get_celery_client") as queue:
            await decide_action(db, u, action_id=a.id)
            assert db.execute.call_args.args[0]._for_update_arg is not None
            assert a.status == "approved"
            queue.return_value.send_task.assert_called_once()
            with pytest.raises(ActionDenied):
                await decide_action(db, u, action_id=a.id)
            queue.return_value.send_task.assert_called_once()

    asyncio.run(scenario())
