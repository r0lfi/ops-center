import re
import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.ai import AIAgent, AITask, open_task_counts
from worker_ai.events import publish_agent_event

_MAX_ACTIVITY_LEN = 500

# The Ops Floor turns these into animations and log lines. Only what really
# happened is published; an event is never inferred by the browser.
EVENTS = (
    "task_started", "tool_started", "tool_finished", "delegated", "returned",
    "approval_requested", "action_started", "action_finished", "completed", "stopped", "error",
)

# Error text reaches a shared page. Keep the cause, drop file paths and
# anything shaped like a credential.
_PATH = re.compile(r"(?<![:/\w])(?:/[\w.@+-]+){2,}/?")
_SECRET = re.compile(r"\b(?:sk|pk|rk|key|token|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}|\b[A-Za-z0-9+/_-]{32,}={0,2}")


def public_error(text: str | None) -> str | None:
    if not text:
        return text
    return _SECRET.sub("[redacted]", _PATH.sub("[path]", text))[:300]


def _default_event(status: str, activity: str | None) -> str | None:
    if status == "error":
        return "error"
    if status == "idle":
        return "completed" if activity is None else "stopped"
    return None


def _other_open_tasks(db: Session, agent, task_id) -> int:
    """Running tasks of this agent other than the one reporting now."""
    if not isinstance(agent, AIAgent) or not hasattr(db, "execute"):
        return 0
    try:
        exclude = uuid.UUID(str(task_id)) if task_id else None
    except ValueError:
        exclude = None
    row = db.execute(open_task_counts(exclude).where(AITask.agent_id == agent.id)).first()
    return int(row.running) if row else 0


def _personal_task(db: Session, task) -> bool:
    """True when the task was started for a personal agent (nova)."""
    if not isinstance(task, AITask):
        return False
    owner_agent = db.get(AIAgent, task.agent_id)
    return isinstance(owner_agent, AIAgent) and bool(owner_agent.personal)


def set_agent_state(
    db: Session,
    agent: AIAgent,
    status: str,
    activity: str | None,
    target: str | None = None,
    task_id: str | None = None,
    *,
    event: str | None = None,
    peer: str | None = None,
    tool: str | None = None,
) -> None:
    """
    The single place that changes an AIAgent's live state - called from
    both worker_ai/tasks.py (the top-level agent a task was created
    against) and worker_ai/ai/runtime.py (every agent a Coordinator
    delegates to), so a delegated specialist's own row - and the Ops
    Floor's live view of it - updates exactly the same way a directly-
    asked agent's does. Writes the DB row first, then publishes - the DB
    is authoritative if the two ever disagree (e.g. a dropped Redis
    connection), matching the "never hallucinate state" policy.
    """
    if status in ("error", "idle", "disabled"):
        activity = public_error(activity)
    event = event or _default_event(status, activity)
    # One agent can run several tasks at once (the Developer agent does). The
    # end of one of them must not mark the agent idle while others still run:
    # the event says this task completed, the agent stays working.
    if status == "idle" and isinstance(agent, AIAgent) and agent.enabled:
        others = _other_open_tasks(db, agent, task_id)
        if others:
            status, activity = "working", f"{others} more task{'s' if others != 1 else ''} running"
    from worker_ai.ai.collaboration import CURRENT
    collaboration = CURRENT.get() is not None
    task = db.get(AITask, task_id) if task_id and not collaboration else None
    incident = isinstance(task, AITask) and task.source == "incident"
    if collaboration or incident:
        activity = ("Collaboration investigation" if collaboration else "Incident investigation") if activity else None
        target, task_id, tool = None, None, None
    elif getattr(agent, "personal", False) or _personal_task(db, task):
        # The Agents page and Ops Floor are shared; the owner's words are not -
        # including a subtask a personal agent wrote for a delegated agent, and
        # errors (the owner still sees them on the task itself).
        if activity:
            activity = "Personal conversation" if getattr(agent, "personal", False) else "Delegated personal request"
        target, task_id, tool = None, None, None
    agent.status = status
    agent.current_task = activity[:_MAX_ACTIVITY_LEN] if activity else None
    agent.last_activity_at = datetime.now(timezone.utc)
    agent.error_message = activity if status == "error" else None
    db.commit()

    publish_agent_event(agent.slug, status, activity, target, task_id, event=event, peer=peer, tool=tool)
