"""Investigation board, resume and tool proposals.

* GET  /ai/tasks/{id}/board       work items, findings, proposals and approvals of one task
* POST /ai/tasks/{id}/resume      continue an unfinished investigation from its saved board
* GET  /ai/proposals              tool proposals
* POST /ai/proposals/{id}/approve admin: approve DEVELOPMENT only (starts the developer agent)
* POST /ai/proposals/{id}/reject  admin
* POST /ai/proposals/{id}/deployed admin: record that a reviewed release shipped an approved change
* GET  /ai/proposals/{id}/patch   the developer agent's diff, for applying on a branch

Approving a proposal never deploys anything or widens any agent's tools:
the patch is applied on a branch by a person (scripts/admin/apply-tool-proposal.sh),
tested, and released through the normal reviewed release process.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import get_current_user, require_role
from app.api.routes.ai import _task_hidden
from app.db.session import get_db
from app.api.routes.ai_developer import approved_sha, record_decision, require_release_auth
from app.models.ai import AIAction, AIAgent, AIChangeReview, AIFinding, AITask, AIToolProposal, AIWorkItem
from app.models.user import User
from app.services.celery_client import get_celery_client
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()
RESUMABLE = ("inconclusive", "blocked", "failed", "waiting_for_approval")


class DeployedRequest(BaseModel):
    note: str = Field(default="", max_length=500)
    # Commit, tag or release the change shipped in.
    release_ref: str = Field(default="", max_length=200)


def _item(row):
    return {"id": str(row.id), "agent": row.agent_slug, "title": row.title, "status": row.status,
            "depends_on": row.depends_on, "result": row.result, "tools": row.tools, "attempts": row.attempts,
            "started_at": row.started_at, "finished_at": row.finished_at, "updated_at": row.updated_at}


def _finding(row, stamp):
    return {"id": str(row.id), "kind": row.kind, "system": row.system, "statement": row.title,
            "evidence": row.description, "source": row.source, "observed_at": row.observed_at,
            "stale": bool(row.stale_after and row.stale_after < stamp)}


def _proposal(row):
    data = {"id": str(row.id), "task_id": str(row.task_id) if row.task_id else None, "title": row.title,
            # A patch still being written part by part is not offered for download.
            "status": row.status, "details": row.details, "has_patch": bool(row.patch) and row.status != "in_development",
            "patch_notes": row.patch_notes, "dev_task_id": str(row.dev_task_id) if row.dev_task_id else None,
            "decided_by": row.decided_by, "decided_at": row.decided_at, "created_at": row.created_at}
    return data


async def _visible_task(db, task_id, user):
    task = await db.get(AITask, task_id)
    if task is None or await _task_hidden(db, task, user):
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.get("/ai/tasks/{task_id}/board")
async def task_board(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    task = await _visible_task(db, task_id, user)
    stamp = datetime.now(timezone.utc)
    items = (await db.execute(select(AIWorkItem).where(AIWorkItem.task_id == task.id).order_by(AIWorkItem.created_at))).scalars().all()
    findings = (await db.execute(select(AIFinding).where(AIFinding.task_id == task.id, AIFinding.fingerprint.is_not(None))
                                 .order_by(AIFinding.observed_at.desc()).limit(50))).scalars().all()
    proposals = (await db.execute(select(AIToolProposal).where(AIToolProposal.task_id == task.id))).scalars().all()
    actions = (await db.execute(select(AIAction).where(AIAction.task_id == task.id).order_by(AIAction.requested_at))).scalars().all()
    resumed = (await db.execute(select(AITask.id).where(AITask.resumed_from == task.id).order_by(AITask.created_at.desc()))).scalars().first()
    return {"task_id": str(task.id), "status": task.status, "outcome": task.outcome,
            "resumable": task.status in ("completed", "failed", "cancelled") and (task.outcome in RESUMABLE or task.status != "completed")
                         and task.owner_user_id == user.id and resumed is None,
            "resumed_by": str(resumed) if resumed else None,
            "items": [_item(r) for r in items], "findings": [_finding(r, stamp) for r in findings],
            "proposals": [_proposal(r) for r in proposals],
            "actions": [{"id": str(a.id), "code": a.request_code, "tool": a.tool, "status": a.status,
                         "level": a.approval_level, "reason": a.reason} for a in actions]}


@router.post("/ai/tasks/{task_id}/resume", status_code=201, dependencies=[Depends(require_role("operator"))])
async def resume_task(task_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    previous = await _visible_task(db, task_id, user)
    if previous.owner_user_id != user.id:
        raise HTTPException(status_code=403, detail="only the person who started the investigation can resume it")
    if previous.status in ("queued", "running"):
        raise HTTPException(status_code=409, detail="investigation is still running")
    if previous.status == "completed" and previous.outcome not in RESUMABLE:
        raise HTTPException(status_code=409, detail="investigation is complete")
    if (await db.execute(select(AITask.id).where(AITask.resumed_from == previous.id))).first():
        raise HTTPException(status_code=409, detail="investigation was already resumed")
    agent = await db.get(AIAgent, previous.agent_id)
    if agent is None or not agent.enabled or agent.runtime != "native":
        raise HTTPException(status_code=409, detail="the agent is unavailable")
    task = AITask(agent_id=agent.id, requested_by=user.username, owner_user_id=user.id,
                  source=previous.source if previous.source in ("web", "talk") else "web",
                  conversation_key=previous.conversation_key, input_message="Resume: " + previous.input_message[:1900],
                  status="queued", resumed_from=previous.id)
    db.add(task)
    await db.commit()
    get_celery_client().send_task("worker_ai.tasks.run_agent_task", args=[str(task.id)], queue="ai")
    return {"task_id": str(task.id)}


@router.get("/ai/proposals")
async def list_proposals(status: str | None = Query(default=None, max_length=30), db: AsyncSession = Depends(get_db),
                         user: User = Depends(get_current_user)) -> list[dict]:
    """Admins decide on proposals and see all; others see only their own.

    A proposal can quote its originating task (an incident, for example),
    so it is never shown more widely than that task.
    """
    query = select(AIToolProposal).order_by(AIToolProposal.created_at.desc()).limit(200)
    if user.role != "admin":
        query = query.where(AIToolProposal.owner_user_id == user.id)
    if status:
        query = query.where(AIToolProposal.status == status)
    return [_proposal(r) for r in (await db.execute(query)).scalars().all()]


async def _proposal_for_update(db, proposal_id):
    row = (await db.execute(select(AIToolProposal).where(AIToolProposal.id == proposal_id).with_for_update())).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="proposal not found")
    return row


@router.post("/ai/proposals/{proposal_id}/approve")
async def approve_proposal(proposal_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_role("admin"))) -> dict:
    """Approve development only. Deployment stays a separate reviewed release."""
    row = await _proposal_for_update(db, proposal_id)
    if row.status not in ("proposed", "changes_requested"):
        raise HTTPException(status_code=409, detail=f"proposal is {row.status}")
    rework = ""
    if row.status == "changes_requested":
        comment = (await db.execute(select(AIChangeReview.comment).where(AIChangeReview.proposal_id == row.id,
                                                                         AIChangeReview.decision == "request_changes")
                                    .order_by(AIChangeReview.decided_at.desc()).limit(1))).scalar_one_or_none()
        # The reviewed patch stays in the review record (by hash); the new run writes a complete new patch.
        rework = f"\n\nA reviewer requested changes to the previous patch:\n{(comment or '')[:1500]}\nSubmit a complete new patch."
        row.patch = None
    developer = (await db.execute(select(AIAgent).where(AIAgent.slug == "developer"))).scalar_one_or_none()
    if developer is None or not developer.enabled or developer.provider_id is None:
        raise HTTPException(status_code=409, detail="the developer agent is not configured or disabled")
    spec = "\n".join(f"{key}: {value}" for key, value in (row.details or {}).items() if value)
    task = AITask(agent_id=developer.id, requested_by=user.username, owner_user_id=user.id, source="development",
                  input_message=(f"Implement the approved tool proposal '{row.title}' ({row.id}).\n{spec}\n\n"
                                 "Work plan: read at most the 3-4 files you will change (start with worker_ai/ai/tools/ and the matching "
                                 "worker_ai/tests/test_*.py), then write the patch. Only these paths are accepted: worker_ai/ai/tools/*.py, "
                                 "worker_ai/tests/test_*.py, backend/app/core/mcp_catalog.json, docs/*.md. Call submit_patch within "
                                 "15 tool calls, one file per call (final=true on the last); an imperfect patch with notes on what is "
                                 "unverified is better than none." + rework)[:8000],
                  status="queued")
    db.add(task)
    await db.flush()
    row.status, row.dev_task_id, row.decided_by, row.decided_at = "in_development", task.id, user.username, datetime.now(timezone.utc)
    await db.commit()
    get_celery_client().send_task("worker_ai.tasks.run_agent_task", args=[str(task.id)], queue="ai")
    return _proposal(row)


@router.post("/ai/proposals/{proposal_id}/reject")
async def reject_proposal(proposal_id: uuid.UUID, db: AsyncSession = Depends(get_db), user: User = Depends(require_role("admin"))) -> dict:
    row = await _proposal_for_update(db, proposal_id)
    if row.status in ("deployed", "rejected", "rolled_back"):
        raise HTTPException(status_code=409, detail=f"proposal is {row.status}")
    record_decision(db, row, user, "reject")
    row.status = "rejected"
    await db.commit()
    return _proposal(row)


@router.post("/ai/proposals/{proposal_id}/deployed")
async def mark_deployed(proposal_id: uuid.UUID, payload: DeployedRequest, db: AsyncSession = Depends(get_db),
                        user: User = Depends(require_release_auth)) -> dict:
    """Bookkeeping after a reviewed release; it deploys nothing itself.

    A developer-agent patch must have been approved, for exactly the stored
    patch, before its release can be recorded. "proposed" (no patch) covers a
    proposal a person implemented without the developer agent.
    """
    row = await _proposal_for_update(db, proposal_id)
    if row.status == "approved":
        if await approved_sha(db, row) is None:
            raise HTTPException(status_code=409, detail="the approval does not match the stored patch")
    elif not (row.status == "proposed" and not row.patch):
        raise HTTPException(status_code=409, detail=f"only an approved change can be released (it is {row.status})")
    record_decision(db, row, user, "released", comment=payload.note, sha=await approved_sha(db, row), ref=payload.release_ref)
    row.status = "deployed"
    if payload.note:
        row.patch_notes = ((row.patch_notes or "") + "\nDeployed: " + payload.note).strip()
    await db.commit()
    return _proposal(row)


@router.get("/ai/proposals/{proposal_id}/patch", response_class=PlainTextResponse, dependencies=[Depends(require_role("admin"))])
async def proposal_patch(proposal_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> str:
    row = await db.get(AIToolProposal, proposal_id)
    if row is None or not row.patch or row.status == "in_development":
        raise HTTPException(status_code=404, detail="no finished patch for this proposal")
    return row.patch
