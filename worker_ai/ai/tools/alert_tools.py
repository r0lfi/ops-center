"""get_alerts tool - proxies Alertmanager, same URL/endpoint as
app/api/routes/alerts.py (kept as its own tiny copy, see metrics_tools.py's
docstring for why)."""
import httpx

ALERTMANAGER_URL = "http://alertmanager:9093"

TOOL_SCHEMA = {
    "name": "get_alerts",
    "description": (
        "Active Alertmanager alerts, optionally filtered to one host. Returns "
        "available=false if Alertmanager can't be reached - never assume there "
        "are no alerts in that case, say the data is unavailable."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string", "description": "Optional - filter to alerts labeled with this hostname/instance"}
        },
        "required": [],
    },
}


def get_alerts(hostname: str | None = None) -> dict:
    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(f"{ALERTMANAGER_URL}/api/v2/alerts")
            resp.raise_for_status()
            alerts = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        return {"available": False, "error": f"Alertmanager unavailable: {exc}"}

    active = [a for a in alerts if a.get("status", {}).get("state") == "active"]
    if hostname:
        active = [
            a for a in active if a.get("labels", {}).get("hostname") == hostname or a.get("labels", {}).get("instance") == hostname
        ]

    return {
        "available": True,
        "count": len(active),
        "alerts": [
            {
                "alertname": a.get("labels", {}).get("alertname"),
                "severity": a.get("labels", {}).get("severity"),
                "hostname": a.get("labels", {}).get("hostname") or a.get("labels", {}).get("instance"),
                "summary": a.get("annotations", {}).get("summary"),
                "starts_at": a.get("startsAt"),
            }
            for a in active[:25]
        ],
    }
