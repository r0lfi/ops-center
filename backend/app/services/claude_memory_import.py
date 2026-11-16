"""Import Claude Code's file-based memory as shared agent notes.

Claude Code keeps one Markdown file per fact (YAML-ish frontmatter with
name/description, then the body) plus a MEMORY.md index. This turns them
into shared ai_memories notes for one owner, keyed `claude.<name>.<nn>`,
so every agent can find the homelab history with recall_memory.

- Chunks stay under recall's 1000-character excerpt so nothing is cut off.
- Lines that look like credentials are dropped, using the same pattern
  worker_ai/ai/memory.py uses to refuse saving them.
- sync_notes() owns the whole `claude.` prefix for that owner: unchanged
  notes are left alone (keeps updated_at), changed ones updated, and
  notes whose source disappeared are deleted. User notes are never touched.
"""
import re
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.models import ai as _ai_models  # noqa: F401 - ai_memories FKs reference ai_agents/ai_tasks
from app.core.memory_rules import CLAUDE_CODE_PREFIX, SECRET_RE
from app.models.ai_memory import AIMemory

KEY_PREFIX = CLAUDE_CODE_PREFIX
MAX_CHUNK = 950
_FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n?", re.S)


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", text.lower()).strip("-")
    return slug[:80] or "note"


def parse_memory_file(text: str, fallback_name: str) -> tuple[str, str, str]:
    """Return (name, description, body)."""
    meta, body = {}, text
    match = _FRONTMATTER_RE.match(text)
    if match:
        body = text[match.end():]
        for line in match.group(1).splitlines():
            if ":" in line and not line.startswith((" ", "\t")):
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta.get("name") or fallback_name, meta.get("description", ""), body.strip()


def _split_long(paragraph: str, limit: int) -> list[str]:
    parts, rest = [], paragraph
    while len(rest) > limit:
        cut = max(rest.rfind(". ", 0, limit), rest.rfind("\n", 0, limit), rest.rfind(" ", 0, limit))
        cut = cut + 1 if cut > limit // 2 else limit
        parts.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    return parts + ([rest] if rest else [])


def chunk_text(body: str, limit: int) -> list[str]:
    chunks, current = [], ""
    for paragraph in re.split(r"\n\s*\n", body):
        for piece in _split_long(paragraph.strip(), limit):
            if current and len(current) + 2 + len(piece) > limit:
                chunks.append(current)
                current = piece
            else:
                current = f"{current}\n\n{piece}" if current else piece
    return chunks + ([current] if current else [])


def strip_secrets(text: str) -> tuple[str, int]:
    kept, dropped = [], 0
    for line in text.splitlines():
        if SECRET_RE.search(line):
            dropped += 1
        else:
            kept.append(line)
    return "\n".join(kept), dropped


def build_notes(files: dict[str, str]) -> tuple[dict[str, str], int]:
    """files: {filename: text} -> ({key: content}, dropped_secret_lines)."""
    notes, dropped_total = {}, 0
    for filename, text in sorted(files.items()):
        stem = Path(filename).stem
        if stem == "MEMORY":
            name, description, body = "index", "Index of all imported notes, one line each", text.strip()
        else:
            name, description, body = parse_memory_file(text, stem)
        body, dropped = strip_secrets(body)
        dropped_total += dropped
        slug = _slug(name)
        header = f"[Claude memory: {name}]"
        if description:
            header += f" {description}"
        header, _ = strip_secrets(header)
        # leave room for the "(part i/n) " marker and the header on part 1
        pieces = chunk_text(body, MAX_CHUNK - 20 - min(len(header), 300))
        if not pieces:
            continue
        for i, piece in enumerate(pieces, 1):
            prefix = f"{header[:300]} (part {i}/{len(pieces)})\n" if i == 1 else f"[{name} part {i}/{len(pieces)}]\n"
            notes[f"{KEY_PREFIX}{slug}.{i:02d}"] = (prefix + piece)[:1000]
    return notes, dropped_total


def read_directory(path: Path) -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(path.glob("*.md"))}


def sync_notes(db, owner_id, notes: dict[str, str], *, dry_run: bool = False) -> dict:
    """Make the owner's shared claude.* notes equal to `notes`. Caller commits."""
    existing = dict(db.execute(
        select(AIMemory.key, AIMemory.content).where(
            AIMemory.user_id == owner_id,
            AIMemory.agent_id.is_(None),
            AIMemory.key.startswith(KEY_PREFIX, autoescape=True),
        )
    ).all())
    changed = {k: v for k, v in notes.items() if existing.get(k) != v}
    removed = sorted(set(existing) - set(notes))
    summary = {"total": len(notes), "created": sum(k not in existing for k in changed),
               "updated": sum(k in existing for k in changed), "deleted": len(removed),
               "unchanged": len(notes) - len(changed)}
    if dry_run:
        return summary
    for key, content in changed.items():
        db.execute(insert(AIMemory).values(user_id=owner_id, agent_id=None, key=key, content=content)
                   .on_conflict_do_update(constraint="uq_ai_memory_user_key",
                                          set_={"content": content, "updated_at": func.now()}))
    if removed:
        db.execute(delete(AIMemory).where(
            AIMemory.user_id == owner_id, AIMemory.agent_id.is_(None), AIMemory.key.in_(removed)))
    return summary
