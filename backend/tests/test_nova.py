"""Nova: Talk room routing, personal tool limits and task privacy."""
import asyncio
import hashlib
import hmac
import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.routes.ai import create_agent, get_task, list_tasks, update_agent
from app.api.routes.integrations import talk_webhook
from app.core.config import TalkAgentRoute, TalkMemoryBinding
from app.core.talk_memory import routed_agent_slug
from app.schemas.ai import AIAgentCreate, AIAgentUpdate

OWNER = uuid.uuid4()
BINDING = TalkMemoryBinding(actor_id="users/owner", room_token="nova1", user_id=OWNER)
ROUTE = TalkAgentRoute(room_token="nova1", agent_slug="nova")


def settings(routes=(ROUTE,), bindings=(BINDING,)):
    return SimpleNamespace(talk_memory_bindings=list(bindings), talk_agent_routes=list(routes))


def test_route_needs_a_bound_owner_in_that_room():
    with patch("app.core.talk_memory.get_settings", return_value=settings()):
        assert routed_agent_slug("nova1", OWNER) == "nova"
        assert routed_agent_slug("nova1", None) is None
        assert routed_agent_slug("otherroom", OWNER) is None
    duplicate = [ROUTE, TalkAgentRoute(room_token="nova1", agent_slug="chat")]
    with patch("app.core.talk_memory.get_settings", return_value=settings(duplicate)):
        assert routed_agent_slug("nova1", OWNER) is None


def test_route_config_rejects_malformed_entries():
    with pytest.raises(ValueError):
        TalkAgentRoute(room_token="bad token", agent_slug="nova")
    with pytest.raises(ValueError):
        TalkAgentRoute(room_token="nova1", agent_slug="Nova")


def _webhook(actor, room, agents, routes=(ROUTE,)):
    payload = {"type": "Create", "actor": {"id": actor, "name": "Owner"}, "target": {"id": room},
               "object": {"id": "7", "name": "message", "content": json.dumps({"message": "Husk at jeg liker svart kaffe"})}}
    body = json.dumps(payload).encode()
    sig = hmac.new(b"test-only", b"nonce" + body, hashlib.sha256).hexdigest()

    async def receive():
        return {"type": "http.request", "body": body}
    request = Request({"type": "http", "headers": [(b"x-nextcloud-talk-random", b"nonce"),
                                                   (b"x-nextcloud-talk-signature", sig.encode())]}, receive)
    db = MagicMock()
    looked_up = []

    async def execute(query):
        slug = query.whereclause.right.value
        looked_up.append(slug)
        return SimpleNamespace(scalar_one_or_none=lambda: agents.get(slug))
    db.execute = execute
    db.get = AsyncMock(side_effect=lambda model, key: SimpleNamespace(id=OWNER, is_active=True) if model.__name__ == "User" else None)
    db.commit = AsyncMock()
    reply = AsyncMock()
    with patch("app.core.talk_memory.get_settings", return_value=settings(routes)), \
         patch("app.api.routes.integrations._talk_secret", return_value="test-only"), \
         patch("app.api.routes.integrations.get_celery_client") as celery, \
         patch("app.api.routes.integrations._reply", reply):
        result = asyncio.run(talk_webhook(request, db))
    task = db.add.call_args.args[0] if db.add.called else None
    return SimpleNamespace(result=result, task=task, looked_up=looked_up, reply=reply, celery=celery)


def _agents(nova_enabled=True, provider=True):
    return {"coordinator": SimpleNamespace(id=uuid.uuid4(), name="Coordinator", enabled=True, runtime="native", provider_id=uuid.uuid4()),
            "nova": SimpleNamespace(id=uuid.uuid4(), name="Nova", enabled=nova_enabled, runtime="native",
                                      provider_id=uuid.uuid4() if provider else None)}


def test_bound_owner_in_routed_room_reaches_nova():
    agents = _agents()
    run = _webhook("users/owner", "nova1", agents)
    assert run.task.agent_id == agents["nova"].id
    assert run.task.owner_user_id == OWNER and run.task.conversation_key == "talk:nova1"
    run.celery.return_value.send_task.assert_called_once()


@pytest.mark.parametrize("actor,room", [("users/someone-else", "nova1"), ("users/owner", "otherroom")])
def test_unbound_sender_or_room_keeps_the_coordinator(actor, room):
    agents = _agents()
    run = _webhook(actor, room, agents)
    assert run.looked_up == ["coordinator"] and run.task.agent_id == agents["coordinator"].id


def test_no_routes_keeps_the_coordinator():
    agents = _agents()
    run = _webhook("users/owner", "nova1", agents, routes=())
    assert run.task.agent_id == agents["coordinator"].id


@pytest.mark.parametrize("enabled,provider", [(False, True), (True, False)])
def test_unavailable_routed_agent_is_never_replaced_by_the_coordinator(enabled, provider):
    run = _webhook("users/owner", "nova1", _agents(enabled, provider))
    assert run.task is None and run.result == {"ignored": "routed agent unavailable"}
    assert "Nova er ikke tilgjengelig" in run.reply.call_args.args[1]
    run.celery.return_value.send_task.assert_not_called()


def test_personal_agent_api_refuses_infra_tools():
    db = AsyncMock()
    db.execute.return_value = MagicMock(scalar_one_or_none=lambda: None)
    payload = AIAgentCreate(slug="mine", name="Mine", personal=True, allowed_tools=["web_search", "restart_service"])
    with pytest.raises(HTTPException) as error:
        asyncio.run(create_agent(payload, db))
    assert error.value.status_code == 422 and "restart_service" in error.value.detail
    nova = SimpleNamespace(personal=True)
    db.get.return_value = nova
    with pytest.raises(HTTPException):
        asyncio.run(update_agent(uuid.uuid4(), AIAgentUpdate(allowed_tools=["run_shell_command"]), db))
    asyncio.run(update_agent(uuid.uuid4(), AIAgentUpdate(allowed_tools=["web_fetch"], allowed_dispatch_targets=["coordinator"]), db))
    assert nova.allowed_tools == ["web_fetch"] and nova.allowed_dispatch_targets == ["coordinator"]


def test_personal_agent_tasks_are_owner_only():
    task = SimpleNamespace(source="talk", agent_id=uuid.uuid4(), owner_user_id=OWNER)
    db = AsyncMock()
    db.get.side_effect = lambda model, key: task if model.__name__ == "AITask" else SimpleNamespace(personal=True)
    with pytest.raises(HTTPException) as error:
        asyncio.run(get_task(uuid.uuid4(), db, SimpleNamespace(id=uuid.uuid4())))
    assert error.value.status_code == 404
    assert asyncio.run(get_task(uuid.uuid4(), db, SimpleNamespace(id=OWNER))) is task
    db.get.side_effect = lambda model, key: task if model.__name__ == "AITask" else SimpleNamespace(personal=False)
    assert asyncio.run(get_task(uuid.uuid4(), db, SimpleNamespace(id=uuid.uuid4()))) is task


def test_task_list_hides_other_owners_personal_agent_tasks():
    db = AsyncMock()
    db.execute.return_value = MagicMock(scalars=lambda: MagicMock(all=lambda: []))
    asyncio.run(list_tasks(limit=50, agent="nova", mine=True, db=db, current_user=SimpleNamespace(id=OWNER)))
    sql = str(db.execute.call_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "ai_tasks.agent_id NOT IN (SELECT ai_agents.id" in sql and "ai_agents.personal IS true" in sql
    assert "ai_agents.slug = 'nova'" in sql and sql.count(f"ai_tasks.owner_user_id = '{OWNER.hex}'") == 2
