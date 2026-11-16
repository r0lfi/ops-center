"""Shared rules for changing personal notes: validation, version snapshots and duplicates.

Every change to an existing note (edit, scope move, merge, delete, restore,
an agent overwriting a key, accepting an update suggestion) first stores the
note's previous state in ai_memory_versions, so it can be undone. Used by the
API (async session) and the worker (sync session): the helpers only build
values and statements.
"""
import re

from sqlalchemy import insert

from app.core.memory_rules import KEY_RE, SECRET_RE, reserved_prefix
from app.models.ai_memory import MEMORY_KINDS, AIMemoryVersion

# Owner-written notes may be long (the UI supports long texts); agents keep
# writing short notes (worker_ai/ai/memory.py) and recall returns excerpts.
MAX_NOTE = 8000
MAX_CATEGORY = 80
_WORD = re.compile(r"[\w-]{3,}", re.UNICODE)


def clean_category(value):
    """Trimmed, single-spaced category or None; raises ValueError when invalid."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Category must be text.")
    value = " ".join(value.split())
    if len(value) > MAX_CATEGORY:
        raise ValueError(f"Category is limited to {MAX_CATEGORY} characters.")
    return value or None


def note_problem(key, content, *, kind=None, allow_reserved=None, max_len=MAX_NOTE):
    """Why a note may not be stored, or None."""
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        return "Use a short key of letters, digits, '.', '_' or '-' (at most 100)."
    if not isinstance(content, str) or not 1 <= len(content.strip()) <= max_len:
        return f"Provide a non-empty note of at most {max_len} characters."
    if SECRET_RE.search(content) or SECRET_RE.search(key):
        return "Notes cannot contain credentials such as passwords, tokens or private keys."
    if kind is not None and kind not in MEMORY_KINDS:
        return f"Kind must be one of {', '.join(MEMORY_KINDS)}."
    prefix = reserved_prefix(key)
    if prefix and prefix != allow_reserved:
        return f"Keys starting with {prefix!r} are reserved."
    return None


def snapshot(note, change: str, changed_by: str):
    """INSERT of the note's current state before `change` replaces it."""
    return insert(AIMemoryVersion).values(
        memory_id=note.id, user_id=note.user_id, agent_id=note.agent_id, key=note.key, category=note.category,
        kind=note.kind, content=note.content, change=change, changed_by=changed_by)


def words(text: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(text or "")}


def similarity(a: str, b: str) -> float:
    """Jaccard similarity of the two texts' words (0..1)."""
    wa, wb = words(a), words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def duplicate_pairs(notes, threshold=0.6):
    """[(id_a, id_b, score)] for notes that say (nearly) the same; reserved imports excluded."""
    candidates = [(n, words(n.content)) for n in notes if not reserved_prefix(n.key)]
    pairs = []
    for i, (a, wa) in enumerate(candidates):
        for b, wb in candidates[i + 1:]:
            if wa and wb:
                score = len(wa & wb) / len(wa | wb)
                if score >= threshold:
                    pairs.append((a.id, b.id, round(score, 2)))
    return pairs
