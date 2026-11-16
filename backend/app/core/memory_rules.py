"""Shared rules for personal memory: what may be stored and which keys are reserved.

Used by the agent memory tools (worker_ai/ai/memory.py), the Claude Code
import, memory suggestions and the nova imports, so they all filter the
same credential pattern and refuse the same reserved key prefixes.
"""
import hashlib
import re

# Lines or notes that look like credentials are never stored or imported.
SECRET_RE = re.compile(r"(?i)(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]|-----BEGIN .*PRIVATE KEY|\bsk-[a-zA-Z0-9]{12,}")
KEY_RE = re.compile(r"[a-zA-Z0-9_.-]{1,100}")

# Written only by the admin import of Claude Code's memory.
CLAUDE_CODE_PREFIX = "claude."
# Nova's nightly journal notes (one per day).
JOURNAL_PREFIX = "nova.journal."
# Memory lists imported from other assistants, by source.
IMPORT_PREFIXES = {"chatgpt": "chatgpt.", "claude": "claudeai.", "gemini": "gemini.", "other": "imported."}

# Models may not write these with remember_fact or suggest_memory, and they
# never take the automatic note slots in an agent's context.
RESERVED_PREFIXES = (CLAUDE_CODE_PREFIX, JOURNAL_PREFIX, *IMPORT_PREFIXES.values())


def reserved_prefix(key: str) -> str | None:
    lowered = key.lower()
    return next((p for p in RESERVED_PREFIXES if lowered.startswith(p)), None)


def content_hash(text: str) -> str:
    """Stable identity of a note's meaning: case and whitespace do not matter."""
    normalized = " ".join(text.lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()
