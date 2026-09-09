"""
Nextcloud Talk bot webhook - "Ask Ops AI" from a Talk conversation.

Nextcloud POSTs every message of a conversation the bot is enabled in to
this endpoint (ActivityPub-ish envelope), signed with the bot's shared
secret. Auth here is that signature, verified by hand - NOT the app's
bearer-token dependency (Nextcloud has no Ops Center account), so main.py
registers this router without dependencies=_AUTH, exactly like
containers.ws_router and ai.stream_router. The reply is posted back by
worker_ai (worker_ai/talk.py) once the Coordinator has answered - this
route only enqueues, so Nextcloud gets its 200 immediately.

Protocol (Talk bot API v1): request headers X-Nextcloud-Talk-Random and
X-Nextcloud-Talk-Signature (hex HMAC-SHA256 over random + raw body),
X-Nextcloud-Talk-Backend (the Nextcloud base URL to reply to).
"""
import hashlib
import hmac
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.talk_memory import bound_user_id
from app.models.user import User
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.services.celery_client import get_celery_client
from app.services.connectivity import _resolve_secret

logger = logging.getLogger("integrations.talk")
router = APIRouter()

_MAX_BODY = 64 * 1024
_MAX_MESSAGE = 4000


def _talk_secret() -> str:
    try:
        return _resolve_secret(get_settings().talk_bot_secret_path).read_text().strip()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Talk bot is not configured (no shared secret)") from exc


@router.post("/integrations/talk/webhook", status_code=200)
async def talk_webhook(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    body = await request.body()
    if len(body) > _MAX_BODY:
        raise HTTPException(status_code=413, detail="payload too large")

    random_header = request.headers.get("x-nextcloud-talk-random", "")
    signature = request.headers.get("x-nextcloud-talk-signature", "")
    backend = request.headers.get("x-nextcloud-talk-backend", "")
    if not random_header or not signature or not backend:
        raise HTTPException(status_code=401, detail="missing Talk signature headers")

    expected = hmac.new(_talk_secret().encode(), random_header.encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise HTTPException(status_code=401, detail="bad Talk signature")

    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid JSON") from exc

    # Only new chat messages - joins, reactions, system messages etc. are
    # acknowledged and ignored. The bot's own messages come back through
    # here too (actor "bots/..."), and must never trigger another answer.
    if payload.get("type") != "Create":
        return {"ignored": "not a message"}
    obj = payload.get("object") or {}
    actor = payload.get("actor") or {}
    target = payload.get("target") or {}
    if obj.get("name") != "message" or str(actor.get("id", "")).startswith("bots/"):
        return {"ignored": "not a user message"}

    try:
        content = json.loads(obj.get("content") or "{}")
    except ValueError:
        content = {}
    message = str(content.get("message") or "").strip()
    token = str(target.get("id") or "")
    if not message or not token:
        return {"ignored": "empty message"}

    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "coordinator"))).scalar_one_or_none()
    if agent is None or not agent.enabled:
        raise HTTPException(status_code=503, detail="Coordinator agent is not available")

    # Only the signed immutable actor ID and explicitly approved room can bind memory.
    # Display names are never account identifiers.
    owner_id = bound_user_id(actor.get("id"), token)
    owner = await db.get(User, owner_id) if owner_id else None
    owner_id = owner.id if owner is not None and owner.is_active else None
    task = AITask(
        agent_id=agent.id,
        requested_by=f"talk:{actor.get('id') or 'unknown'}",
        owner_user_id=owner_id,
        source="talk",
        # Every message in the same Talk room is one ongoing conversation -
        # see worker_ai/tasks.py's _build_contextual_message.
        conversation_key=f"talk:{token}",
        input_message=message[:_MAX_MESSAGE],
        status="queued",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    get_celery_client().send_task(
        "worker_ai.tasks.run_talk_task",
        args=[str(task.id), token, backend, str(obj.get("id") or "")],
        queue="ai",
    )
    logger.info("talk: queued task %s for room %s from %s", task.id, token, actor.get("name"))
    return {"task_id": str(task.id)}
