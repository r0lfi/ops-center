"""
get_server_metrics tool.

PromQL expressions are copied from app/api/routes/metrics.py (source of
truth for the exact expressions - keep the two in sync by hand if either
changes) rather than imported: worker_ai's Docker build deliberately
doesn't pull in FastAPI or the rest of app/api just for these query
strings, matching the project's existing convention of small duplicated
files per component (see redis_client.py in every worker).
"""
import httpx

PROMETHEUS_URL = "http://prometheus:9090"

_QUERIES = {
    "cpu_percent": '100 - (avg by (instance) (irate(node_cpu_seconds_total{{mode="idle", instance="{instance}"}}[5m])) * 100)',
    "memory_percent": '(1 - (node_memory_MemAvailable_bytes{{instance="{instance}"}} / node_memory_MemTotal_bytes{{instance="{instance}"}})) * 100',
    "disk_percent": (
        '(1 - (node_filesystem_avail_bytes{{fstype!~"tmpfs|overlay", mountpoint="/", instance="{instance}"}} '
        '/ node_filesystem_size_bytes{{fstype!~"tmpfs|overlay", mountpoint="/", instance="{instance}"}})) * 100'
    ),
}

TOOL_SCHEMA = {
    "name": "get_server_metrics",
    "description": (
        "Current CPU%, memory%, and root-disk% for one managed host, read directly "
        "from Prometheus. Returns available=false if Prometheus can't be reached - "
        "never assume a value in that case."
    ),
    "parameters": {
        "type": "object",
        "properties": {"hostname": {"type": "string", "description": "Exact hostname, e.g. ops-host"}},
        "required": ["hostname"],
    },
}


def get_server_metrics(hostname: str) -> dict:
    try:
        with httpx.Client(timeout=10.0) as client:
            values = {}
            for metric, expr_template in _QUERIES.items():
                expr = expr_template.format(instance=hostname)
                resp = client.get(f"{PROMETHEUS_URL}/api/v1/query", params={"query": expr})
                resp.raise_for_status()
                result = resp.json().get("data", {}).get("result", [])
                values[metric] = round(float(result[0]["value"][1]), 1) if result else None
    except (httpx.HTTPError, ValueError) as exc:
        return {"available": False, "error": f"Prometheus unavailable: {exc}"}

    return {"available": True, "hostname": hostname, **values}
