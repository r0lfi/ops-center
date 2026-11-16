"""Investigation board, shared findings and tool proposals.

* Work items: the coordinator's plan. dispatch_to_agent moves an item through
  queued -> running -> completed / inconclusive / failed / waiting_for_approval,
  committing each step, so an interrupted run leaves a usable checkpoint.
* Findings: operational memory shared by all infrastructure agents, with a
  kind (fact / hypothesis / ruled_out / resolution), the system, the source
  tool and when it goes stale. Identical findings update one row.
* Tool proposals: a missing capability, reviewed by a person in Ops Center.

All ownership comes from the task row, never from model arguments.
"""
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app.core.memory_rules import SECRET_RE
from app.models import user as _user_model  # noqa: F401  (FK target of proposals and findings)
from app.models.ai import (AIFinding, AITask, AIToolProposal, AIWorkItem, FINDING_KINDS)

MAX_ITEMS_PER_TASK = 12
MAX_ATTEMPTS_PER_ITEM = 2
MAX_PROPOSALS_PER_TASK = 3
DEFAULT_VALID_HOURS = {"fact": 24, "hypothesis": 6, "ruled_out": 24, "resolution": 24 * 90}
INFRA_SOURCES = ("web", "talk", "incident")

PLAN_SCHEMA = {
    "name": "plan_work",
    "description": "Adds work items to this investigation's board: one per focused question, with the specialist that should answer it. "
                   "Returns the item ids to pass to dispatch_to_agent. depends_on lists keys of items whose result this one needs.",
    "parameters": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string", "description": "Short label unique in this plan, e.g. 'logs'"},
        "agent": {"type": "string"}, "subtask": {"type": "string"},
        "depends_on": {"type": "array", "items": {"type": "string"}}}, "required": ["key", "agent", "subtask"]}}},
        "required": ["items"]},
}
FINDING_SCHEMA = {
    "name": "record_finding",
    "description": "Saves one established statement to the shared operational memory so other agents and later investigations reuse it. "
                   "Never include passwords, keys or tokens.",
    "parameters": {"type": "object", "properties": {
        "kind": {"type": "string", "enum": list(FINDING_KINDS)},
        "system": {"type": "string", "description": "Host, service or URL it is about, e.g. 'nextcloud@docker-host-02'"},
        "statement": {"type": "string", "description": "One sentence, at most 300 characters"},
        "evidence": {"type": "string", "description": "The observation that supports it, at most 600 characters"},
        "source": {"type": "string", "description": "Tool that produced the evidence"},
        "valid_hours": {"type": "integer", "description": "How long it stays current; defaults by kind"}},
        "required": ["kind", "system", "statement"]},
}
PROPOSAL_SCHEMA = {
    "name": "propose_tool",
    "description": "Proposes a missing capability for a person to review in Ops Center. Use only after checking that no available tool can do it. "
                   "Approval allows development only; deployment is a separate decision.",
    "parameters": {"type": "object", "properties": {
        "title": {"type": "string", "description": "Short name, e.g. 'tls_check diagnostic'"},
        "missing": {"type": "string", "description": "What is missing"},
        "reason": {"type": "string", "description": "Why the current task needs it"},
        "design": {"type": "string", "description": "How it should work: inputs, outputs, read or write"},
        "reuse": {"type": "string", "description": "Existing APIs or components to reuse"},
        "security": {"type": "string", "description": "Security consequences and abuse cases"},
        "permissions": {"type": "string", "description": "Rights it requires; whether it must be approval-gated"},
        "tests": {"type": "string", "description": "How to test it"}},
        "required": ["title", "missing", "reason", "design", "security", "permissions", "tests"]},
}
PATCH_SCHEMA = {
    "name": "submit_patch",
    "description": "Submits the implementation of the approved proposal as unified diff (git diff format, against the repository root). "
                   "Send one file per call to keep each call short; set final=true on the last call. Parts are joined in order.",
    "parameters": {"type": "object", "properties": {
        "diff": {"type": "string", "description": "Unified diff for one or more files"},
        "notes": {"type": "string", "description": "What this part does; on the final call also security notes, how to test, what is unverified"},
        "final": {"type": "boolean", "description": "true on the last part; the patch then goes to review"}},
        "required": ["diff", "notes", "final"]},
}


def now():
    return datetime.now(timezone.utc)


def infra_task(task):
    return isinstance(task, AITask) and task.owner_user_id is not None and task.source in INFRA_SOURCES


def _clean(value, limit):
    return " ".join(str(value or "").split())[:limit]


# --- work items ---------------------------------------------------------------

def plan(db, task, items, targets):
    if not isinstance(items, list) or not items:
        return {"error": "items must be a non-empty list"}
    existing = db.execute(select(AIWorkItem).where(AIWorkItem.task_id == task.id)).scalars().all()
    if len(existing) + len(items) > MAX_ITEMS_PER_TASK:
        return {"error": f"At most {MAX_ITEMS_PER_TASK} work items per investigation; use the existing items"}
    known = {(row.agent_slug, row.title.lower()): row for row in existing}
    created, keys = [], {}
    for item in items:
        if not isinstance(item, dict):
            return {"error": "each item must be an object"}
        agent, title = item.get("agent"), _clean(item.get("subtask"), 2000)
        if agent not in targets or not title:
            return {"error": f"item {item.get('key')!r}: agent must be one of {', '.join(targets)} and subtask must be text"}
        row = known.get((agent, title.lower()))
        if row is None:
            row = AIWorkItem(id=uuid.uuid4(), task_id=task.id, agent_slug=agent, title=title, status="queued", depends_on=[])
            db.add(row)
            known[(agent, title.lower())] = row
        keys[str(item.get("key") or len(keys))] = row
        created.append((item, row))
    for item, row in created:
        deps = [str(keys[k].id) for k in item.get("depends_on") or [] if k in keys and keys[k] is not row]
        if deps:
            row.depends_on = deps
    db.commit()
    return {"items": [{"key": key, "work_item": str(row.id), "agent": row.agent_slug, "status": row.status,
                       "depends_on": row.depends_on} for key, row in keys.items()]}


def claim(db, task_id, work_item_id, agent_slug, title):
    """The item a dispatch runs under: the named one, or a new ad-hoc item."""
    row = None
    if work_item_id:
        try:
            row = db.get(AIWorkItem, uuid.UUID(str(work_item_id)))
        except ValueError:
            row = None
        if row is None or str(row.task_id) != str(task_id):
            return None, "Unknown work_item for this investigation"
        if row.agent_slug != agent_slug:
            return None, f"Work item belongs to {row.agent_slug}"
        if row.status in ("completed", "waiting_for_approval"):
            return None, f"Work item is already {row.status}; reuse its result"
        if row.attempts >= MAX_ATTEMPTS_PER_ITEM:
            return None, "Work item already ran twice; summarise what is known or plan a different question"
        open_deps = [d for d in row.depends_on or [] if (dep := db.get(AIWorkItem, uuid.UUID(d))) is not None
                     and dep.status not in ("completed", "inconclusive", "failed", "waiting_for_approval")]
        if open_deps:
            return None, "Dispatch the items it depends on first"
    else:
        # A dispatch without its item id takes the oldest planned item still
        # queued for that specialist, so the plan does not keep stale entries.
        row = db.execute(select(AIWorkItem).where(AIWorkItem.task_id == task_id, AIWorkItem.agent_slug == agent_slug,
                                                  AIWorkItem.status == "queued").order_by(AIWorkItem.created_at).limit(1)).scalar_one_or_none()
    if row is None:
        count = db.execute(select(AIWorkItem.id).where(AIWorkItem.task_id == task_id)).all()
        if len(count) >= MAX_ITEMS_PER_TASK:
            return None, f"At most {MAX_ITEMS_PER_TASK} delegations per investigation; summarise what is known"
        row = AIWorkItem(id=uuid.uuid4(), task_id=uuid.UUID(str(task_id)), agent_slug=agent_slug, title=_clean(title, 2000), depends_on=[])
        db.add(row)
    row.status, row.started_at, row.attempts = "running", now(), (row.attempts or 0) + 1
    db.commit()
    return row, None


def finish(db, row, result, approval_tools):
    if row is None:
        return
    db.refresh(row)
    pending = [t["tool"] for t in result.tools_used if t.get("tool") in approval_tools]
    if pending:
        row.status = "waiting_for_approval"
    elif result.partial:
        row.status = "inconclusive"
    else:
        row.status = "completed"
    row.result = (result.text or "")[:4000]
    row.tools = [t.get("tool") for t in result.tools_used][-40:]
    row.finished_at = now()
    db.commit()


def fail(db, row, reason):
    if row is None:
        return
    db.rollback()
    db.refresh(row)
    row.status, row.result, row.finished_at = "failed", _clean(reason, 1000), now()
    db.commit()


def board_summary(db, task_id, limit_chars=600):
    rows = db.execute(select(AIWorkItem).where(AIWorkItem.task_id == task_id).order_by(AIWorkItem.created_at)).scalars().all()
    return [{"agent": r.agent_slug, "question": r.title[:300], "status": r.status,
             "result": (r.result or "")[:limit_chars]} for r in rows]


def outcome(db, task_id, partial):
    statuses = {r for (r,) in db.execute(select(AIWorkItem.status).where(AIWorkItem.task_id == task_id)).all()}
    if "waiting_for_approval" in statuses:
        return "waiting_for_approval"
    if partial or statuses & {"inconclusive", "failed", "queued", "running"}:
        return "inconclusive"
    return "completed"


def resume_message(db, previous):
    """New model context for a resumed run: the question plus the saved board, not the old transcript."""
    lines = [f"Resume this investigation. Original request: {previous.input_message[:2000]}", "",
             "Saved state of the previous run (checkpoint):"]
    for item in board_summary(db, previous.id):
        lines.append(f"- [{item['status']}] {item['agent']}: {item['question']}\n  result: {item['result'] or '-'}")
    if previous.response_message:
        lines += ["", "Previous summary: " + previous.response_message[:1500]]
    lines += ["", "Reuse completed results. Plan and dispatch only what is still open or inconclusive."]
    return "\n".join(lines)


# --- findings -------------------------------------------------------------------

def record_finding(db, task, agent, args):
    kind = args.get("kind")
    system, statement = _clean(args.get("system"), 200), _clean(args.get("statement"), 300)
    evidence, source = _clean(args.get("evidence"), 600), _clean(args.get("source"), 100)
    if kind not in FINDING_KINDS or not system or not statement:
        return {"error": f"kind must be one of {', '.join(FINDING_KINDS)}; system and statement are required"}
    if SECRET_RE.search(" ".join((statement, evidence))):
        return {"error": "Findings must not contain credentials or secrets"}
    hours = args.get("valid_hours")
    hours = hours if isinstance(hours, int) and 1 <= hours <= 24 * 365 else DEFAULT_VALID_HOURS[kind]
    fingerprint = hashlib.sha256(f"{kind}|{system.lower()}|{statement.lower()}".encode()).hexdigest()
    row = db.execute(select(AIFinding).where(AIFinding.fingerprint == fingerprint)).scalar_one_or_none()
    stamp = now()
    if row is None:
        row = AIFinding(agent_id=agent.id, task_id=task.id, kind=kind, system=system, title=statement,
                        description=evidence or None, evidence={"source": source} if source else {}, source=source or None,
                        owner_user_id=task.owner_user_id, fingerprint=fingerprint, severity="info")
        db.add(row)
    else:
        row.task_id, row.agent_id, row.description = task.id, agent.id, evidence or row.description
    row.observed_at, row.stale_after = stamp, stamp + timedelta(hours=hours)
    db.commit()
    return {"saved": True, "kind": kind, "system": system, "valid_until": row.stale_after.isoformat(timespec="minutes")}


def findings_for(db, query, limit=8):
    words = [w for w in re.findall(r"[\w.@:-]{3,}", (query or "").lower())][:8]
    if not words:
        return []
    match = or_(*(or_(AIFinding.system.icontains(w, autoescape=True), AIFinding.title.icontains(w, autoescape=True)) for w in words))
    rows = db.execute(select(AIFinding).where(AIFinding.fingerprint.is_not(None), match)
                      .order_by(AIFinding.observed_at.desc()).limit(40)).scalars().all()
    stamp = now()
    scored = sorted(rows, key=lambda r: -sum(w in f"{r.system} {r.title}".lower() for w in words))[:limit]
    return [{"kind": r.kind, "system": r.system, "statement": r.title, "evidence": (r.description or "")[:300],
             "source": r.source, "observed": r.observed_at.isoformat(timespec="minutes"),
             "stale": bool(r.stale_after and r.stale_after < stamp)} for r in scored]


# --- proposals ------------------------------------------------------------------

# Code legitimately mentions "token:" or "password=" (for example in redaction
# rules), so a patch is checked for credential *values* only: key material,
# well-known key formats, and quoted literals assigned to secret-like names.
PATCH_SECRET_RE = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bAKIA[0-9A-Z]{16}\b"
    r"|(?i:(?:password|passwd|secret|api[_-]?key|token|auth)\s*[:=]\s*['\"][^'\"\s]{8,}['\"])"
    # Unquoted values (YAML, .env, ini): a letter-and-digit run, so names such as
    # password=get_password() or token: str do not match.
    r"|(?i:(?:password|passwd|secret|api[_-]?key|token|auth)\s*[:=]\s*(?=[A-Za-z0-9+/_.-]*[0-9])(?=[A-Za-z0-9+/_.-]*[A-Za-z])[A-Za-z0-9+/_.-]{10,}(?![(\w]))")

_PROPOSAL_FIELDS = ("missing", "reason", "design", "reuse", "security", "permissions", "tests")


def propose(db, task, agent, args):
    title = _clean(args.get("title"), 200)
    details = {key: str(args.get(key) or "")[:2000] for key in _PROPOSAL_FIELDS}
    if not title or not all(details[k] for k in ("missing", "reason", "design", "security", "permissions", "tests")):
        return {"error": "title, missing, reason, design, security, permissions and tests are required"}
    if SECRET_RE.search(" ".join(details.values())):
        return {"error": "Proposals must not contain credentials or secrets"}
    same = db.execute(select(AIToolProposal).where(AIToolProposal.title.ilike(title),
                                                   AIToolProposal.status.in_(("proposed", "approved", "in_development", "ready_for_review", "changes_requested")))).scalar_one_or_none()
    if same is not None:
        return {"proposal": str(same.id), "status": same.status, "note": "An open proposal with this title already exists"}
    count = db.execute(select(AIToolProposal.id).where(AIToolProposal.task_id == task.id)).all()
    if len(count) >= MAX_PROPOSALS_PER_TASK:
        return {"error": "Proposal limit for this investigation reached"}
    row = AIToolProposal(id=uuid.uuid4(), task_id=task.id, agent_id=agent.id, owner_user_id=task.owner_user_id,
                         title=title, details=details, status="proposed")
    db.add(row)
    db.commit()
    return {"proposal": str(row.id), "status": "proposed",
            "note": "Waiting for a person to review it under AI Approvals > Tool proposals. Mention it in your answer."}


def submit_patch(db, task, args):
    row = db.execute(select(AIToolProposal).where(AIToolProposal.dev_task_id == task.id)).scalar_one_or_none()
    if row is None or row.status != "in_development":
        return {"error": "No proposal is in development for this task"}
    diff, notes = str(args.get("diff") or ""), str(args.get("notes") or "")[:4000]
    final = args.get("final", True) is not False
    combined = ((row.patch.rstrip("\n") + "\n") if row.patch else "") + diff
    if not diff.lstrip().startswith(("diff --git", "--- ")) or len(combined) > 200_000:
        return {"error": "diff must be a unified diff; the whole patch must stay under 200,000 characters"}
    for number, line in enumerate(diff.splitlines(), 1):
        if PATCH_SECRET_RE.search(line):
            return {"error": f"Diff line {number} looks like a real credential value; use a placeholder or read it from configuration"}
    if PATCH_SECRET_RE.search(notes):
        return {"error": "The notes look like they contain a credential value; remove it"}
    row.patch = combined
    row.patch_notes = "\n".join(part for part in (row.patch_notes, notes) if part)[-8000:]
    if not final:
        db.commit()
        return {"saved": True, "status": "in_development", "parts": combined.count("diff --git") or 1,
                "note": "Part saved. Send the next file, and final=true with the last one."}
    row.status = "ready_for_review"
    db.commit()
    return {"saved": True, "status": "ready_for_review",
            "note": "A person applies it on a branch, runs the tests and decides on deployment separately."}


def release_unfinished_proposal(db, task):
    """A development run that ended without a patch hands the proposal back for a new decision."""
    row = db.execute(select(AIToolProposal).where(AIToolProposal.dev_task_id == task.id)).scalar_one_or_none()
    if row is None or row.status != "in_development":
        return
    # A fixed category only: model or provider text never reaches the proposal.
    stop = (task.error_message or "").lower()
    reason = ("tool budget used up" if "verktøybudsjett" in stop or "tool call limit" in stop else
              "output limit reached" if "output limit" in stop else
              "time budget used up" if "time budget" in stop else
              "finished without submitting" if task.status == "completed" else f"task {task.status}")
    row.status = "proposed"
    if row.patch:
        # An unfinished multi-part patch is not reviewable; drop it with the run.
        row.patch, reason = None, reason + " (partial patch discarded)"
    row.patch_notes = ((row.patch_notes or "") + f"\nDeveloper run {str(task.id)[:8]} ended without a patch: {reason}").strip()
