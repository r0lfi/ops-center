from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.ai import AIAgent
from worker_ai.events import publish_agent_event

_MAX_ACTIVITY_LEN = 500


def set_agent_state(
    db: Session,
    agent: AIAgent,
    status: str,
    activity: str | None,
    target: str | None = None,
    task_id: str | None = None,
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
    agent.status = status
    agent.current_task = activity[:_MAX_ACTIVITY_LEN] if activity else None
    agent.last_activity_at = datetime.now(timezone.utc)
    agent.error_message = activity if status == "error" else None
    db.commit()

    publish_agent_event(agent.slug, status, activity, target, task_id)
