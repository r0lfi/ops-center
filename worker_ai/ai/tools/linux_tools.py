"""Linux Operations Agent tools - all go through Ansible (see
ansible_ops.py), the same playbooks the rest of Ops Center already uses
for these exact checks, extended with a structured OPS_CENTER_QUERY_RESULT
passthrough (see ansible/playbooks/{health-check,service-check,process-check}.yml)."""
from worker_ai.ansible_ops import run_ansible_query

GET_SERVICE_STATUS_SCHEMA = {
    "name": "get_service_status",
    "description": (
        "Current systemd unit state (active/inactive/failed/unknown) for one service on one "
        "managed host, via a live Ansible check. Returns available=false if the host couldn't "
        "be reached - never assume a service's status in that case."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "service": {"type": "string", "description": "systemd unit name, e.g. nginx or docker"},
        },
        "required": ["hostname", "service"],
    },
}

GET_DISK_USAGE_SCHEMA = {
    "name": "get_disk_usage",
    "description": (
        "Uptime, load average, memory/swap, and per-filesystem disk usage for one managed "
        "host, via a live Ansible check. Returns available=false if the host couldn't be reached."
    ),
    "parameters": {"type": "object", "properties": {"hostname": {"type": "string"}}, "required": ["hostname"]},
}

GET_RUNNING_PROCESSES_SCHEMA = {
    "name": "get_running_processes",
    "description": (
        "Top processes by CPU usage on one managed host, via a live Ansible check. Each result "
        "line is 'PID COMMAND CPU% MEM%'. Returns available=false if the host couldn't be reached."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "limit": {"type": "integer", "description": "How many processes to return, default 15", "default": 15},
        },
        "required": ["hostname"],
    },
}


def get_service_status(hostname: str, service: str) -> dict:
    return run_ansible_query(hostname, "service-check.yml", {"services": [service]})


def get_disk_usage(hostname: str) -> dict:
    return run_ansible_query(hostname, "health-check.yml", {})


def get_running_processes(hostname: str, limit: int = 15) -> dict:
    return run_ansible_query(hostname, "process-check.yml", {"process_limit": limit})
