"""Shared approval invariants; no transport, model calls or execution."""

import json
from datetime import datetime, timezone
from app.core.talk_memory import task_binding_valid


class ActionDenied(ValueError):
    def __init__(self, message, status_code=409):
        super().__init__(message)
        self.status_code = status_code


def validate_decision(action, parent, user, *, actor_id=None, room_token=None):
    if not user or not user.is_active or user.role not in ("operator", "admin"):
        raise ActionDenied("Operator- eller administratorrettighet kreves.", 403)
    if action.approval_level >= 3 and user.role != "admin":
        raise ActionDenied("Denne handlingen krever administrator.", 403)
    if action.status != "pending":
        raise ActionDenied(f"Handlingen er allerede {action.status}.")
    if not action.expires_at or action.expires_at <= datetime.now(timezone.utc):
        raise ActionDenied("Godkjenningen er utløpt. Be agenten om en ny vurdering.")
    if parent is None or parent.status == "cancelled":
        raise ActionDenied("Oppgaven mangler eller er stoppet.")
    if actor_id is not None or room_token is not None:
        if len(json.dumps(action.arguments, ensure_ascii=False, indent=2)) > 2500:
            raise ActionDenied(
                "Se hele handlingen og godkjenn i Ops Center; den er for lang for Talk."
            )
        if (
            parent.source != "talk"
            or not task_binding_valid(parent)
            or parent.owner_user_id != user.id
            or parent.requested_by != f"talk:{actor_id}"
            or parent.conversation_key != f"talk:{room_token}"
        ):
            raise ActionDenied(
                "Handlingen tilhører ikke din bruker i dette Talk-rommet."
            )
