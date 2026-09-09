"""
get_network_traffic_summary tool for the Network Agent.

traffic_watch.py's live event buffer lives in ops-api's own process memory
(a different container from this worker), so it can't be read directly -
instead it publishes a periodic snapshot to Redis (see that module's
_publish_snapshot) that this tool reads back. Returns available=false if
no snapshot has ever been published (Traffic Map not configured, or ops-api
hasn't completed a poll tick yet) - never guess at traffic in that case.
"""
import json

from worker_ai.redis_client import get_redis_client

_REDIS_SNAPSHOT_KEY = "traffic_watch:snapshot"
_MAX_EVENTS_TO_MODEL = 20

TOOL_SCHEMA = {
    "name": "get_network_traffic_summary",
    "description": (
        "Recent inbound traffic seen at the edge (edge-host's Caddy and the home reverse proxy): "
        "request counts, distinct client countries, and any 4xx/5xx ('suspicious') requests - the "
        "same feed the Traffic Map page shows. Returns available=false if no data has been "
        "published yet."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def get_network_traffic_summary() -> dict:
    try:
        redis_client = get_redis_client()
        raw = redis_client.get(_REDIS_SNAPSHOT_KEY)
    except Exception as exc:
        return {"available": False, "error": f"Redis unavailable: {exc}"}

    if raw is None:
        return {"available": False, "error": "no Traffic Map data has been published yet"}

    data = json.loads(raw)
    events = data.get("events", [])
    suspicious = [e for e in events if e.get("suspicious")]
    countries = sorted({e["country"] for e in events if e.get("country")})

    return {
        "available": True,
        "event_count": len(events),
        "suspicious_count": len(suspicious),
        "distinct_countries": countries,
        "destinations": data.get("destinations", {}),
        "recent_events": [
            {
                "ip": e.get("ip"),
                "city": e.get("city"),
                "country": e.get("country"),
                "domain": e.get("domain"),
                "status": e.get("status"),
                "suspicious": e.get("suspicious"),
            }
            for e in events[-_MAX_EVENTS_TO_MODEL:]
        ],
    }
