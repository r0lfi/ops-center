"""Retryable, deduplicated 80% budget warning through administrator Talk rooms."""
import asyncio
import hashlib
import logging
from app.db.session import async_session_factory
from app.services.ai_budget import budget_status
from app.core.config import get_settings
from app.models.incidents import IMSettings
from app.models.user import User
from sqlalchemy import select
from app.services.talk_watch import notify_once

log = logging.getLogger("ai.budget.watch")


async def poll_once():
    async with async_session_factory() as db:
        budget = await budget_status(db)
        config = await db.get(IMSettings, 1)
        owner_id = (config.value or {}).get("investigation_owner_user_id") if config else None
        owner = await db.scalar(select(User).where(User.id == owner_id, User.is_active.is_(True), User.role == "admin")) if owner_id else None
        settings = get_settings()
        rooms = {binding.room_token for binding in settings.talk_memory_bindings if owner and binding.user_id == owner.id} if settings.talk_notifications_enabled else set()
    if not budget["warning"] and not budget["pricing_unknown"]:
        return
    message = (
        f"Ops Center AI budget warning: the shared weekly limit is ${budget['limit_usd']:.2f}. "
        f"Reported usage estimate: ${budget['billed_usd']:.2f}; reserved or uncertain: ${budget['reserved_usd']:.2f}; "
        f"available: ${budget['remaining_usd']:.2f}. New paid calls stop before the limit. "
        f"The budget resets {budget['reset_at']}. Check AI settings for current usage."
    )
    if budget['pricing_unknown']:
        message += " Unpriced historical usage requires review; paid calls are blocked."
    for room in rooms:
        digest = hashlib.sha256(room.encode()).hexdigest()[:24]
        await notify_once(f"ai-budget:{budget['week_start']}:{digest}:80", room, message, ttl=1209600)


async def watch_loop():
    while True:
        try:
            await poll_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("AI budget warning delivery failed; retrying")
        await asyncio.sleep(15)
