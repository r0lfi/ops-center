"""One decision boundary for web and signature-verified Talk."""

from datetime import datetime, timezone
from sqlalchemy import select
from app.models.ai import AIAction, AITask
from app.models.audit import AuditLogEntry
from app.core.action_policy import validate_decision, ActionDenied
from app.services.celery_client import get_celery_client


async def decide_action(
    db,
    user,
    *,
    action_id=None,
    request_code=None,
    approve=True,
    actor_id=None,
    room_token=None,
):
    query = (
        select(AIAction).where(AIAction.id == action_id)
        if action_id
        else select(AIAction).where(AIAction.request_code == request_code)
    )
    action = (await db.execute(query.with_for_update())).scalar_one_or_none()
    if action is None:
        raise ActionDenied("Fant ikke godkjenningskoden.", 404)
    parent = await db.get(AITask, action.task_id) if action.task_id else None
    validate_decision(action, parent, user, actor_id=actor_id, room_token=room_token)
    action.status = "approved" if approve else "rejected"
    action.approved_by = user.username
    action.approved_at = datetime.now(timezone.utc)
    action.result = {
        "approval_user_id": str(user.id),
        "approval_source": "talk" if actor_id else "web",
    }
    db.add(
        AuditLogEntry(
            user=user.username,
            action="POST",
            target=f"/ai/actions/{action.id}/{'approve' if approve else 'reject'}",
            parameters={
                "source": "talk" if actor_id else "web",
                "request_code": action.request_code,
            },
            result="200",
            detail="Explicit human decision; no model authorization",
        )
    )
    await db.commit()
    await db.refresh(action)
    if approve:
        # If enqueue fails, the approved row remains visible. Recovery retries
        # dispatch only; the worker atomically claims before any side effect.
        get_celery_client().send_task(
            "worker_ai.tasks.execute_action_task", args=[str(action.id)], queue="ai"
        )
    return action
