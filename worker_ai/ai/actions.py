"""
Approval-request creation for write/execute tools.

request_approval is the ONLY thing that happens when an agent "calls"
restart_service/run_ansible_job/reboot_host/run_shell_command during a
run - see runtime.py's dispatch loop and exec_tools.py's module docstring
for why this never performs the action itself.
"""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ai import AIAction, AIAgent
from app.models.host import Host
from worker_ai.ai.agent_state import set_agent_state
from worker_ai.ai.tools.exec_tools import TOOL_ACTION_LABEL, TOOL_APPROVAL_LEVEL, TOOL_RISK

APPROVAL_EXPIRY_MINUTES = 15


def request_approval(
    db: Session, agent: AIAgent, tool_name: str, arguments: dict, task_id: str | None, reason: str
) -> dict:
    # Reuse an identical, still-live request instead of minting a new code
    # every time - real incident: an agent re-asked the same question (or a
    # human said "approved" back in a chat, which has never been wired to
    # anything - only the actual Approve button in Ops Center is) and each
    # retry created its own AIAction, so approving code #1 while the agent
    # had already moved on to code #2 looked like nothing ever happened.
    # Only pending/approved (not yet executed) rows count, and only while
    # still within their own expiry window - this is "is there already an
    # in-flight identical request", never "was this already run before"
    # (a rerun of an already-executed command is a deliberate new run).
    now = datetime.now(timezone.utc)
    existing = db.execute(
        select(AIAction)
        .where(
            AIAction.tool == tool_name,
            AIAction.arguments == arguments,
            AIAction.status.in_(("pending", "approved")),
            AIAction.expires_at > now,
        )
        .order_by(AIAction.requested_at.desc())
    ).scalars().first()
    if existing is not None:
        return {
            "status": "pending_approval" if existing.status == "pending" else "approved_awaiting_execution",
            "request_code": existing.request_code,
            "action": existing.action,
            "risk": existing.risk,
            "approval_level": existing.approval_level,
            "message": (
                f"An identical request is already {existing.status} (request code {existing.request_code}) - "
                "reusing it instead of creating a new one. "
                + (
                    "An operator (or admin, for a level-3 action) still needs to approve it in Ops Center - "
                    "tell the user this plainly and give them the code."
                    if existing.status == "pending"
                    else "It's already approved and will execute shortly on its own - no further action needed."
                )
            ),
        }

    hostname = arguments.get("hostname")
    host = (
        db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none() if hostname else None
    )

    level = TOOL_APPROVAL_LEVEL.get(tool_name, 3)
    label = TOOL_ACTION_LABEL.get(tool_name, lambda a: tool_name)(arguments)
    risk = TOOL_RISK.get(tool_name, "medium")
    request_code = f"ACT-{now.year}-{uuid.uuid4().hex[:8].upper()}"

    action = AIAction(
        request_code=request_code,
        agent_id=agent.id,
        task_id=task_id,
        host_id=host.id if host else None,
        action=label,
        tool=tool_name,
        arguments=arguments,
        approval_level=level,
        risk=risk,
        reason=reason,
        status="pending",
        source="web",
        requested_by=None,  # the human who *asked the agent* the original question, not tracked per-action here yet
        requested_at=now,
        expires_at=now + timedelta(minutes=APPROVAL_EXPIRY_MINUTES),
    )
    db.add(action)
    db.commit()
    db.refresh(action)

    set_agent_state(db, agent, "waiting", f"Waiting for approval: {label}", hostname, task_id)

    return {
        "status": "pending_approval",
        "request_code": action.request_code,
        "action": label,
        "risk": risk,
        "approval_level": level,
        "message": (
            f"ACTION REQUIRES APPROVAL: {label}. Risk: {risk}. Request code {action.request_code}. "
            "An operator (or admin, for a level-3 action) must approve this in Ops Center before "
            "anything happens - tell the user this plainly and give them the code."
        ),
    }
