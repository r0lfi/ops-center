import httpx
from fastapi import APIRouter

router = APIRouter()

ALERTMANAGER_URL = "http://alertmanager:9093"


@router.get("/alerts")
async def list_alerts() -> dict:
    """
    Proxies Alertmanager's own API. Degrades gracefully (per the failure
    handling policy: "if Prometheus is unavailable, show monitoring
    unavailable instead of crashing") rather than raising when the
    monitoring stack is down.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{ALERTMANAGER_URL}/api/v2/alerts")
            resp.raise_for_status()
            alerts = resp.json()
        return {"available": True, "alerts": alerts}
    except (httpx.HTTPError, ValueError):
        return {"available": False, "alerts": []}
