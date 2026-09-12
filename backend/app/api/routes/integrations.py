"""Signature-verified Talk input with deterministic commands and delivery dedup."""

import hashlib
import hmac
import json
import logging
import re
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import get_settings
from app.core.talk_memory import bound_user_id
from app.core.action_policy import ActionDenied
from app.models.user import User
from app.db.session import get_db
from app.models.ai import AIAgent, AITask
from app.services.celery_client import get_celery_client
from app.services.connectivity import _resolve_secret
from app.services.action_approval import decide_action
from app.services.talk_notify import send_talk

logger = logging.getLogger("integrations.talk")
router = APIRouter()
_MAX_BODY = 64 * 1024
_MAX_MESSAGE = 4000
_COMMAND = re.compile(
    r"^(godkjenn|avvis|approve|reject)\s+(ACT-\d{4}-[A-F0-9]{8})$", re.I
)
HELP = "Godkjenn en konkret handling med: godkjenn ACT-ÅÅÅÅ-KODE. Avvis med: avvis ACT-ÅÅÅÅ-KODE. Bruk den nøyaktige koden agenten viser. Et vanlig «ja» gir aldri godkjenning."


def _talk_secret():
    try:
        return _resolve_secret(get_settings().talk_bot_secret_path).read_text().strip()
    except (OSError, ValueError) as exc:
        raise HTTPException(503, "Talk bot is not configured") from exc


async def _reply(token, message):
    try:
        await send_talk(token, message)
    except Exception:
        logger.exception("Talk notification failed")


@router.post("/integrations/talk/webhook", status_code=200)
async def talk_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.body()
    if len(body) > _MAX_BODY:
        raise HTTPException(413, "payload too large")
    nonce = request.headers.get("x-nextcloud-talk-random", "")
    signature = request.headers.get("x-nextcloud-talk-signature", "")
    if not nonce or not signature:
        raise HTTPException(401, "missing Talk signature")
    expected = hmac.new(
        _talk_secret().encode(), nonce.encode() + body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise HTTPException(401, "bad Talk signature")
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError()
        obj = payload.get("object") or {}
        actor = payload.get("actor") or {}
        target = payload.get("target") or {}
        if not all(isinstance(x, dict) for x in (obj, actor, target)):
            raise ValueError()
        if payload.get("type") != "Create" or obj.get("name") != "message":
            return {"ignored": "not a message"}
        actor_id = str(actor.get("id", ""))
        if not actor_id.startswith("users/"):
            return {"ignored": "not an authenticated user"}
        content = json.loads(obj.get("content") or "{}")
        message = content.get("message", "")
        if not isinstance(message, str):
            raise ValueError()
        message = message.strip()
        token = str(target.get("id") or "")
        message_id = str(obj.get("id") or "")
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(400, "invalid Talk message") from exc
    if not message or not re.fullmatch(r"[a-zA-Z0-9]{4,64}", token):
        return {"ignored": "empty/invalid message"}
    if len(message) > _MAX_MESSAGE:
        await _reply(
            token, "Meldingen er for lang. Del den opp; ingen handling er startet."
        )
        return {"ignored": "message too long"}
    owner_id = bound_user_id(actor_id, token)
    owner = await db.get(User, owner_id) if owner_id else None
    owner_id = owner.id if owner is not None and owner.is_active else None
    match = _COMMAND.fullmatch(message)
    if match:
        try:
            if owner_id is None:
                raise ActionDenied(
                    "Talk-brukeren og rommet er ikke koblet til en aktiv Ops-konto."
                )
            action = await decide_action(
                db,
                owner,
                request_code=match.group(2).upper(),
                approve=match.group(1).lower() in ("godkjenn", "approve"),
                actor_id=actor_id,
                room_token=token,
            )
            await _reply(
                token,
                f"{action.request_code}: {'Godkjent og lagt i kø. Du får resultat her.' if action.status=='approved' else 'Avvist. Handlingen blir ikke kjørt.'}",
            )
            return {"decision": action.status}
        except ActionDenied as exc:
            await db.rollback()
            await _reply(token, str(exc))
            return {"decision": "denied"}
    if message.lower() in ("hjelp", "help") or re.match(
        r"^(godkjenn|avvis|approve|reject)\b", message, re.I
    ):
        await _reply(token, HELP)
        return {"help": True}
    if not message_id.isdigit():
        raise HTTPException(400, "message id required")
    delivery_id = uuid.uuid5(
        uuid.NAMESPACE_URL, f"ops-talk:{token}:{actor_id}:{message_id}"
    )
    existing = await db.get(AITask, delivery_id)
    if existing is not None:
        return {"task_id": str(existing.id), "duplicate": True}
    # Route arbitrary registered environments through the coordinator; a
    # deployment-specific hostname prefix must never select an agent.
    slug = "coordinator"
    agent = (
        await db.execute(select(AIAgent).where(AIAgent.slug == slug))
    ).scalar_one_or_none()
    if agent is None or not agent.enabled:
        raise HTTPException(503, "Coordinator is not available")
    task = AITask(
        id=delivery_id,
        agent_id=agent.id,
        requested_by=f"talk:{actor_id}",
        owner_user_id=owner_id,
        source="talk",
        conversation_key=f"talk:{token}",
        input_message=message,
        status="queued",
    )
    db.add(task)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if await db.get(AITask, delivery_id) is not None:
            return {"task_id": str(delivery_id), "duplicate": True}
        raise
    get_celery_client().send_task(
        "worker_ai.tasks.run_talk_task",
        args=[str(task.id), token, get_settings().talk_backend_url, message_id],
        queue="ai",
    )
    await _reply(
        token,
        f"Mottatt – jeg undersøker nå. Oppgave {str(task.id)[:8]}. Du får fremdrift her hvis det tar litt tid.",
    )
    return {"task_id": str(task.id)}
