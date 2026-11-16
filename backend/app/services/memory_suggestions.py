"""Validation and insert of memory suggestions, shared by nova (worker) and imports (API).

A suggestion is never a note: the owner accepts, edits or rejects it. The
unique (user_id, content_hash) row keeps an accepted or rejected observation
from being proposed again, whatever its key.
"""
import uuid

from sqlalchemy.dialects.postgresql import insert

from app.core.memory_rules import KEY_RE, SECRET_RE, content_hash, reserved_prefix
from app.models.ai_memory import MEMORY_KINDS, AIMemorySuggestion
from app.services.memory_store import clean_category

MAX_CONTENT = 2000


def suggestion_row(user_id, agent_id, key, content, source, evidence_task_id=None, *, allowed_prefix=None,
                   category=None, kind=None, target_memory_id=None):
    """Return (values, None) for a valid suggestion or (None, reason)."""
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        return None, "Use a short stable key of letters, digits, '.', '_' or '-'."
    if not isinstance(content, str) or not 1 <= len(content.strip()) <= MAX_CONTENT:
        return None, f"Provide a non-empty note of at most {MAX_CONTENT} characters."
    if SECRET_RE.search(content) or SECRET_RE.search(key):
        return None, "Credentials are never suggested or stored."
    prefix = reserved_prefix(key)
    if prefix and prefix != allowed_prefix:
        return None, f"Keys starting with {prefix!r} are reserved."
    if kind is not None and kind not in MEMORY_KINDS:
        return None, f"Kind must be one of {', '.join(MEMORY_KINDS)}."
    try:
        category = clean_category(category)
    except ValueError as exc:
        return None, str(exc)
    return {"id": uuid.uuid4(), "user_id": user_id, "agent_id": agent_id, "key": key, "content": content.strip(),
            "source": source, "evidence_task_id": evidence_task_id, "status": "pending",
            "content_hash": content_hash(content), "category": category, "kind": kind,
            "target_memory_id": target_memory_id}, None


def insert_new(rows):
    """INSERT ... ON CONFLICT DO NOTHING; returns the ids actually inserted."""
    return (insert(AIMemorySuggestion).values(rows)
            .on_conflict_do_nothing(constraint="uq_ai_memory_suggestion_hash")
            .returning(AIMemorySuggestion.id))
