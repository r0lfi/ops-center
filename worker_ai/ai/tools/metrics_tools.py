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
import re
import os
from concurrent.futures import ThreadPoolExecutor

PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL", "http://prometheus:9090")

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
        "Current CPU%, memory%, root-disk% and all filesystem usage with sample timestamps for one managed host, read directly "
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
    if not isinstance(hostname,str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,253}",hostname):
        return {"available":False,"error":"Invalid hostname"}
    queries={k:v.format(instance=hostname) for k,v in _QUERIES.items()}
    queries["filesystems"] = '(1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",instance="'+hostname+'"}/node_filesystem_size_bytes{fstype!~"tmpfs|overlay",instance="'+hostname+'"})*100'
    try:
        with httpx.Client(timeout=8.0) as client:
            def fetch(item):
                name,expr=item
                resp=client.get(f"{PROMETHEUS_URL}/api/v1/query",params={"query":expr})
                resp.raise_for_status()
                data=resp.json()
                if data.get("status")!="success":raise ValueError("Prometheus query failed")
                return name,data.get("data",{}).get("result",[])
            with ThreadPoolExecutor(max_workers=4) as pool:
                rows=dict(pool.map(fetch,queries.items()))
        values={name:round(float(result[0]["value"][1]),1) if result else None for name,result in rows.items() if name!="filesystems"}
        values["filesystems"]=[{"mountpoint":r["metric"].get("mountpoint"),"device":r["metric"].get("device"),
            "used_percent":round(float(r["value"][1]),1),"sample_timestamp":r["value"][0]} for r in rows["filesystems"]]
        values["sample_timestamp"]=min((float(r["value"][0]) for result in rows.values() for r in result),default=None)
    except (httpx.HTTPError,ValueError,KeyError,TypeError) as exc:
        return {"available":False,"error":f"Prometheus unavailable: {type(exc).__name__}"}
    return {"available":any(result for result in rows.values()),"hostname":hostname,**values}
