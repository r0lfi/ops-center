"""Explicit mapping for signature-verified Talk users in approved private bot rooms."""
from app.core.config import get_settings


def bound_user_id(actor_id, room_token):
    if not isinstance(actor_id, str) or not actor_id.startswith("users/") or not room_token:
        return None
    matches = {b.user_id for b in get_settings().talk_memory_bindings
               if b.actor_id == actor_id and b.room_token == room_token}
    return next(iter(matches)) if len(matches) == 1 else None


def task_binding_valid(task):
    if not task.conversation_key or not task.conversation_key.startswith("talk:"):
        return False
    if not task.requested_by or not task.requested_by.startswith("talk:users/"):
        return False
    return task.owner_user_id is not None and task.owner_user_id == bound_user_id(
        task.requested_by.removeprefix("talk:"), task.conversation_key.removeprefix("talk:"))


def routed_agent_slug(room_token, owner_id):
    """Agent slug for a routed room, or None for the coordinator default.

    A route only applies to a sender already bound to an active owner in
    this room (owner_id from bound_user_id); unbound senders, guests and
    other rooms keep the coordinator.
    """
    if owner_id is None or not room_token:
        return None
    slugs = {r.agent_slug for r in get_settings().talk_agent_routes if r.room_token == room_token}
    return next(iter(slugs)) if len(slugs) == 1 else None
