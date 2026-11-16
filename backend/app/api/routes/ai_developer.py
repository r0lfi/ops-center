"""Developer Agent: what it works on, what it produced, and the human review gate.

* GET  /ai/developer/overview               every developer change, with live run state
* GET  /ai/developer/changes/{proposal_id}  timeline, runs, changed files, checks, decisions
* POST /ai/proposals/{id}/review            admin: approve / request_changes / reject a finished patch
* POST /ai/proposals/{id}/release-outcome   admin: record a failed release or a rollback

The gate: a patch is approved for production only by an admin in a browser
session with a password confirmed in the last few minutes, never by an agent
or MCP principal (they have no such session), and the approval names the
patch's SHA-256. A patch changed afterwards is not approved. Nothing here
deploys: an approved patch is applied by a person
(scripts/admin/apply-tool-proposal.sh refuses one whose hash was not
approved) and released through the reviewed release process, which is then
recorded with POST /ai/proposals/{id}/deployed.
"""
import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_recent_auth
from app.db.session import get_db
from app.models.ai import AIAgent, AIChangeReview, AITask, AIToolProposal
from app.models.user import User

router = APIRouter()

# Same allowlist as scripts/admin/apply-tool-proposal.sh: the paths a new agent tool needs.
ALLOWED_PATH = re.compile(r"^(worker_ai/ai/tools/[a-z0-9_]+\.py|worker_ai/tests/test_[a-z0-9_]+\.py"
                          r"|backend/app/core/mcp_catalog\.json|docs/[A-Za-z0-9_.-]+\.md)$")
# Production approval and release records need a password confirmed in this session.
require_release_auth = require_recent_auth("admin")

# Stored status -> what the overview calls it.
STAGE = {
    "proposed": "proposed", "in_development": "working", "ready_for_review": "ready_for_review",
    "changes_requested": "changes_requested", "approved": "approved", "deployed": "in_production",
    "rejected": "rejected", "release_failed": "failed", "rolled_back": "rolled_back",
}


def patch_sha256(patch: str | None) -> str | None:
    return hashlib.sha256(patch.encode()).hexdigest() if patch else None


def diffstat(patch: str | None) -> list[dict]:
    """Files a unified diff changes, with added/removed line counts."""
    files: list[dict] = []
    current = None
    for line in (patch or "").splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/", 1)
            current = {"path": parts[1] if len(parts) == 2 else line[11:], "added": 0, "removed": 0, "status": "modified"}
            files.append(current)
        elif current is None and line.startswith("+++ "):
            current = {"path": line[4:].removeprefix("b/"), "added": 0, "removed": 0, "status": "modified"}
            files.append(current)
        elif current is not None:
            if line.startswith("new file mode"):
                current["status"] = "added"
            elif line.startswith("deleted file mode"):
                current["status"] = "deleted"
            elif line.startswith("+") and not line.startswith("+++"):
                current["added"] += 1
            elif line.startswith("-") and not line.startswith("---"):
                current["removed"] += 1
    return files


def _kind(path: str) -> str:
    if "/tests/" in path or path.split("/")[-1].startswith("test_"):
        return "test"
    if path.startswith("docs/"):
        return "docs"
    if path.endswith(".json"):
        return "config"
    return "code"


def checks(row: AIToolProposal) -> list[dict]:
    """Checks Ops Center actually performed. Tests are never claimed as run."""
    if not row.patch or row.status == "in_development":
        return []
    files = diffstat(row.patch)
    outside = [f["path"] for f in files if not ALLOWED_PATH.match(f["path"])]
    tests = [f["path"] for f in files if _kind(f["path"]) == "test"]
    return [
        {"name": "Credential scan", "result": "passed",
         "detail": "Every part of the patch was scanned for credential values when it was submitted."},
        {"name": "Path allowlist", "result": "failed" if outside else "passed",
         "detail": ("Outside the tool allowlist: " + ", ".join(outside)) if outside else "Only agent-tool, test, catalog and docs paths."},
        {"name": "Tests included", "result": "passed" if tests else "warning",
         "detail": ", ".join(tests) if tests else "The patch adds or changes no test file."},
        {"name": "Test run", "result": "not_run",
         "detail": "Ops Center does not execute model-written code. Run the tests on the branch after applying it."},
    ]


async def _visible(db, user, proposal_id) -> AIToolProposal:
    row = await db.get(AIToolProposal, proposal_id)
    if row is None or (user.role != "admin" and row.owner_user_id != user.id):
        raise HTTPException(404, "change not found")
    return row


async def _runs(db, rows) -> dict[uuid.UUID, list[AITask]]:
    """Developer runs per proposal: the current one, and earlier ones that named the proposal id."""
    developer = (await db.execute(select(AIAgent.id).where(AIAgent.slug == "developer"))).scalar_one_or_none()
    out: dict[uuid.UUID, list[AITask]] = {r.id: [] for r in rows}
    if developer is None or not rows:
        return out
    ids = {str(r.id): r.id for r in rows}
    tasks = (await db.execute(select(AITask).where(AITask.agent_id == developer, AITask.source == "development")
                              .order_by(AITask.created_at.desc()).limit(500))).scalars().all()
    for task in tasks:
        for key, pid in ids.items():
            if key in (task.input_message or "") or any(r.dev_task_id == task.id and r.id == pid for r in rows):
                out[pid].append(task)
    return out


def _run(task: AITask) -> dict:
    return {"id": str(task.id), "status": task.status, "outcome": task.outcome, "requested_by": task.requested_by,
            "created_at": task.created_at, "started_at": task.started_at, "completed_at": task.completed_at,
            "duration_ms": task.duration_ms, "tools_used": len(task.tools_used or []),
            "error": (task.error_message or "")[:300] or None}


def _summary(row: AIToolProposal, runs: list[AITask], reviews: list[AIChangeReview], proposer: str | None) -> dict:
    files = diffstat(row.patch)  # while in development: the parts submitted so far
    current = next((t for t in runs if t.id == row.dev_task_id), runs[0] if runs else None)
    stage = STAGE.get(row.status, row.status)
    if row.status == "in_development" and current is not None and current.status in ("failed", "cancelled"):
        stage = "failed"
    approval = next((r for r in reviews if r.decision == "approve"), None)
    released = next((r for r in reviews if r.decision == "released"), None)
    return {
        "id": str(row.id), "title": row.title, "status": row.status, "stage": stage,
        "summary": (row.details or {}).get("missing") or (row.details or {}).get("design") or "",
        "proposed_by": proposer, "developer_run": _run(current) if current else None, "runs": len(runs),
        "files": len(files), "added": sum(f["added"] for f in files), "removed": sum(f["removed"] for f in files),
        "has_patch": bool(row.patch) and row.status != "in_development",
        "patch_sha256": patch_sha256(row.patch) if row.status != "in_development" else None,
        "approved_by": approval.decided_by if approval else None, "approved_at": approval.decided_at if approval else None,
        "release_ref": released.release_ref if released else None,
        "branch": f"tool-proposal/{str(row.id)[:8]}" if row.patch else None,
        "created_at": row.created_at, "updated_at": row.updated_at,
        "started_at": current.started_at if current else None,
        "finished_at": (released.decided_at if released else current.completed_at if current else None),
    }


@router.get("/ai/developer/overview")
async def overview(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    agent = (await db.execute(select(AIAgent).where(AIAgent.slug == "developer"))).scalar_one_or_none()
    query = select(AIToolProposal).order_by(AIToolProposal.updated_at.desc()).limit(200)
    if user.role != "admin":
        query = query.where(AIToolProposal.owner_user_id == user.id)
    rows = (await db.execute(query)).scalars().all()
    runs = await _runs(db, rows)
    reviews: dict[uuid.UUID, list[AIChangeReview]] = {r.id: [] for r in rows}
    if rows:
        for review in (await db.execute(select(AIChangeReview).where(AIChangeReview.proposal_id.in_(list(reviews)))
                                        .order_by(AIChangeReview.decided_at.desc()))).scalars():
            reviews[review.proposal_id].append(review)
    agent_names = dict((await db.execute(select(AIAgent.id, AIAgent.name))).all())
    items = [_summary(r, runs[r.id], reviews[r.id], agent_names.get(r.agent_id)) for r in rows]
    counts: dict[str, int] = {}
    for item in items:
        counts[item["stage"]] = counts.get(item["stage"], 0) + 1
    return {
        "agent": {"name": agent.name, "status": agent.status, "activity": agent.current_task, "enabled": agent.enabled,
                  "configured": agent.provider_id is not None} if agent else None,
        "counts": counts, "items": items, "can_decide": user.role == "admin",
    }


@router.get("/ai/developer/changes/{proposal_id}")
async def change_detail(proposal_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    row = await _visible(db, user, proposal_id)
    runs = (await _runs(db, [row]))[row.id]
    reviews = (await db.execute(select(AIChangeReview).where(AIChangeReview.proposal_id == row.id)
                                .order_by(AIChangeReview.decided_at.desc()))).scalars().all()
    proposer = (await db.get(AIAgent, row.agent_id)).name if row.agent_id else None
    files = diffstat(row.patch) if row.status != "in_development" else []
    for f in files:
        f["kind"] = _kind(f["path"])
    run_ids = [t.id for t in runs]
    traffic = 0
    if run_ids:
        traffic = (await db.execute(text("SELECT count(*) FROM ai_traffic_events WHERE task_id = ANY(:ids)"),
                                    {"ids": run_ids})).scalar_one()
    timeline = [{"at": row.created_at, "kind": "proposed", "text": f"Proposed{' by ' + proposer if proposer else ''}"}]
    for task in runs:
        timeline.append({"at": task.created_at, "kind": "run_queued", "text": f"Development approved by {task.requested_by or 'unknown'}"})
        if task.started_at:
            timeline.append({"at": task.started_at, "kind": "run_started", "text": "Developer Agent started"})
        if task.completed_at:
            timeline.append({"at": task.completed_at, "kind": "run_" + task.status,
                             "text": f"Developer Agent run {task.status}" + (f" ({task.outcome})" if task.outcome else "")})
    labels = {"approve": "Approved for production", "request_changes": "Changes requested", "reject": "Rejected",
              "released": "Release recorded", "release_failed": "Release failed", "rolled_back": "Rolled back"}
    for review in reviews:
        timeline.append({"at": review.decided_at, "kind": review.decision, "text": f"{labels[review.decision]} by {review.decided_by}"})
    timeline.sort(key=lambda e: e["at"] or datetime.min.replace(tzinfo=timezone.utc))
    summary = _summary(row, runs, list(reviews), proposer)
    return {
        **summary, "details": row.details, "notes": row.patch_notes, "files_changed": files, "checks": checks(row),
        "runs_detail": [_run(t) for t in runs], "timeline": timeline, "traffic_events": traffic,
        "task_id": str(row.task_id) if row.task_id else None,
        "reviews": [{"decision": r.decision, "comment": r.comment, "patch_sha256": r.patch_sha256, "release_ref": r.release_ref,
                     "decided_by": r.decided_by, "decided_at": r.decided_at} for r in reviews],
    }


class ReviewRequest(BaseModel):
    decision: Literal["approve", "request_changes", "reject"]
    comment: str = Field(default="", max_length=2000)
    # The hash of the patch the reviewer looked at; an approval covers exactly that patch.
    patch_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


async def _locked(db, proposal_id) -> AIToolProposal:
    row = (await db.execute(select(AIToolProposal).where(AIToolProposal.id == proposal_id).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "change not found")
    return row


def record_decision(db, row, user, decision, *, comment=None, sha=None, ref=None):
    db.add(AIChangeReview(proposal_id=row.id, decision=decision, comment=comment or None, patch_sha256=sha,
                          release_ref=ref or None, decided_by=user.username, decided_by_user_id=user.id))
    row.decided_by, row.decided_at = user.username, datetime.now(timezone.utc)


@router.post("/ai/proposals/{proposal_id}/review")
async def review(proposal_id: uuid.UUID, payload: ReviewRequest, db: AsyncSession = Depends(get_db),
                 user: User = Depends(require_release_auth)) -> dict:
    row = await _locked(db, proposal_id)
    if payload.decision == "approve":
        if row.status != "ready_for_review" or not row.patch:
            raise HTTPException(409, f"only a finished patch waiting for review can be approved (it is {row.status})")
        current = patch_sha256(row.patch)
        if payload.patch_sha256 != current:
            raise HTTPException(409, "the patch changed since you opened it; review it again")
        if any(c["result"] == "failed" for c in checks(row)):
            raise HTTPException(409, "a required check failed; request changes instead")
        record_decision(db, row, user, "approve", comment=payload.comment, sha=current)
        row.status = "approved"
    elif payload.decision == "request_changes":
        if row.status not in ("ready_for_review", "approved"):
            raise HTTPException(409, f"change is {row.status}")
        if not payload.comment.strip():
            raise HTTPException(422, "say what should change")
        record_decision(db, row, user, "request_changes", comment=payload.comment, sha=patch_sha256(row.patch))
        row.status = "changes_requested"
    else:
        if row.status in ("deployed", "rejected", "rolled_back"):
            raise HTTPException(409, f"change is {row.status}")
        record_decision(db, row, user, "reject", comment=payload.comment, sha=patch_sha256(row.patch))
        row.status = "rejected"
    await db.commit()
    return {"id": str(row.id), "status": row.status, "stage": STAGE.get(row.status, row.status)}


class OutcomeRequest(BaseModel):
    outcome: Literal["release_failed", "rolled_back"]
    note: str = Field(min_length=1, max_length=1000)
    release_ref: str = Field(default="", max_length=200)


@router.post("/ai/proposals/{proposal_id}/release-outcome")
async def release_outcome(proposal_id: uuid.UUID, payload: OutcomeRequest, db: AsyncSession = Depends(get_db),
                          user: User = Depends(require_release_auth)) -> dict:
    """Record what happened to an approved or released change. It changes no system."""
    row = await _locked(db, proposal_id)
    allowed = {"release_failed": ("approved",), "rolled_back": ("deployed",)}[payload.outcome]
    if row.status not in allowed:
        raise HTTPException(409, f"change is {row.status}")
    record_decision(db, row, user, payload.outcome, comment=payload.note, sha=patch_sha256(row.patch), ref=payload.release_ref)
    row.status = payload.outcome
    await db.commit()
    return {"id": str(row.id), "status": row.status, "stage": STAGE.get(row.status, row.status)}


async def approved_sha(db, row: AIToolProposal) -> str | None:
    """The patch hash of the latest approval, if it still matches the stored patch."""
    sha = (await db.execute(select(AIChangeReview.patch_sha256).where(AIChangeReview.proposal_id == row.id,
                                                                       AIChangeReview.decision == "approve")
                            .order_by(AIChangeReview.decided_at.desc()).limit(1))).scalar_one_or_none()
    return sha if sha and sha == patch_sha256(row.patch) else None


