import time

from fastapi import APIRouter, Query

from app.services.traffic_watch import get_dest_points, get_recent_events

router = APIRouter()


@router.get("/traffic/live")
async def live_traffic(since: float = Query(default=0.0)) -> dict:
    """Polled by the Traffic Map page every few seconds. `since` is the
    `now` from the previous response - only new events are returned, so the
    frontend never has to de-duplicate."""
    now = time.time()
    return {
        "now": now,
        "events": get_recent_events(since),
        "destinations": get_dest_points(),
    }
