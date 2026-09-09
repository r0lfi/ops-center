"""
Live agent-activity publishing for the Ops Floor.

Same shape as worker/tasks.py's job-event publish-over-Redis-pubsub
pattern (`ansible_job:{id}` channel, consumed by /api/jobs/{id}/stream) -
this is the equivalent for AI agents: one global channel, since the Ops
Floor wants every agent's activity in a single stream rather than one
subscription per agent.
"""
import json
import time

from worker_ai.redis_client import get_redis_client

CHANNEL = "ai_agent_events"


def publish_agent_event(
    agent_slug: str, status: str, activity: str | None, target: str | None, task_id: str | None
) -> None:
    # Never let a Redis hiccup break the actual agent run - the DB row
    # (set by agent_state.set_agent_state, committed just before this is
    # called) remains the source of truth either way.
    try:
        get_redis_client().publish(
            CHANNEL,
            json.dumps(
                {
                    "agent": agent_slug,
                    "status": status,
                    "activity": activity,
                    "target": target,
                    "task_id": task_id,
                    "ts": time.time(),
                },
                default=str,
            ),
        )
    except Exception:
        pass
