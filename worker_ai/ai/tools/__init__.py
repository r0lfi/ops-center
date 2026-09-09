"""
Controlled-tool registry.

Every entry here is a plain Python function with a fixed argument shape -
the LLM only ever picks a name and JSON-schema-validated-by-convention
arguments from this list. It never generates a shell/ansible/docker
command itself (spec requirement: "the LLM must never have unrestricted
shell or SSH access").

Per-agent enforcement of *which* of these an agent may call happens in
worker_ai/ai/runtime.py, against AIAgent.allowed_tools - not here.
"""
from worker_ai.ai.tools.alert_tools import TOOL_SCHEMA as _ALERTS_SCHEMA
from worker_ai.ai.tools.alert_tools import get_alerts
from worker_ai.ai.tools.automation_tools import TOOL_SCHEMA as _PLAYBOOKS_SCHEMA
from worker_ai.ai.tools.automation_tools import list_available_playbooks
from worker_ai.ai.tools.code_tools import LIST_FILES_SCHEMA, READ_FILE_SCHEMA, SEARCH_CODE_SCHEMA
from worker_ai.ai.tools.code_tools import list_repo_files, read_repo_file, search_code
from worker_ai.ai.tools.container_tools import (
    CONTAINER_ENV_KEYS_SCHEMA,
    CONTAINER_LOGS_SCHEMA,
    CONTAINER_VULNS_SCHEMA,
    DOCKER_NETWORKS_SCHEMA,
    LIST_CONTAINERS_SCHEMA,
    get_container_env_keys,
    get_container_logs,
    get_container_vulnerabilities,
    list_containers,
    list_docker_networks,
)
from worker_ai.ai.tools.exec_tools import (
    CONTAINER_ACTION_SCHEMA,
    CONTAINER_EXEC_SCHEMA,
    REBOOT_HOST_SCHEMA,
    RESTART_SERVICE_SCHEMA,
    RUN_ANSIBLE_JOB_SCHEMA,
    SCAN_HOST_SCHEMA,
)
from worker_ai.ai.tools.linux_tools import GET_DISK_USAGE_SCHEMA, GET_RUNNING_PROCESSES_SCHEMA, GET_SERVICE_STATUS_SCHEMA
from worker_ai.ai.tools.linux_tools import get_disk_usage, get_running_processes, get_service_status
from worker_ai.ai.tools.log_tools import TOOL_SCHEMA as _LOGS_SCHEMA
from worker_ai.ai.tools.log_tools import search_logs
from worker_ai.ai.tools.metrics_tools import TOOL_SCHEMA as _METRICS_SCHEMA
from worker_ai.ai.tools.metrics_tools import get_server_metrics
from worker_ai.ai.tools.network_tools import TOOL_SCHEMA as _NETWORK_SCHEMA
from worker_ai.ai.tools.network_tools import get_network_traffic_summary
from worker_ai.ai.tools.patch_tools import LIST_PENDING_PATCHES_SCHEMA, TOOL_SCHEMA as _PATCH_SCHEMA
from worker_ai.ai.tools.patch_tools import get_patch_status, list_pending_patches
from worker_ai.ai.tools.security_tools import SUMMARY_SCHEMA as _SECURITY_SUMMARY_SCHEMA
from worker_ai.ai.tools.security_tools import TOP_VULNS_SCHEMA as _TOP_VULNS_SCHEMA
from worker_ai.ai.tools.security_tools import get_security_summary, list_top_vulnerabilities
from worker_ai.ai.tools.shell_tools import TOOL_SCHEMA as _SHELL_SCHEMA
from worker_ai.ai.tools.web_tools import FETCH_SCHEMA as _WEB_FETCH_SCHEMA
from worker_ai.ai.tools.web_tools import SEARCH_SCHEMA as _WEB_SEARCH_SCHEMA
from worker_ai.ai.tools.web_tools import web_fetch, web_search

# Read-only tools only - the LLM's tool-call executes the function
# directly. Write/execute tools that are *always* gated (restart_service,
# run_ansible_job, reboot_host, run_shell_command, container_action,
# scan_host) are deliberately NOT here: they're schema-only entries below,
# special-cased in runtime.py's dispatch loop to create a pending AIAction
# instead of calling anything (see worker_ai/ai/actions.py and
# exec_tools.py's module docstring).
# test_tools_registry.py's test_write_tools_are_schema_only_not_directly_callable
# documents this.
TOOL_REGISTRY = {
    "get_server_metrics": get_server_metrics,
    "get_alerts": get_alerts,
    "search_logs": search_logs,
    "get_service_status": get_service_status,
    "get_disk_usage": get_disk_usage,
    "get_running_processes": get_running_processes,
    "get_patch_status": get_patch_status,
    "list_pending_patches": list_pending_patches,
    "get_security_summary": get_security_summary,
    "list_top_vulnerabilities": list_top_vulnerabilities,
    "list_containers": list_containers,
    "get_container_vulnerabilities": get_container_vulnerabilities,
    "get_container_logs": get_container_logs,
    "get_container_env_keys": get_container_env_keys,
    "list_docker_networks": list_docker_networks,
    "get_network_traffic_summary": get_network_traffic_summary,
    "list_available_playbooks": list_available_playbooks,
    "web_fetch": web_fetch,
    "web_search": web_search,
    "list_repo_files": list_repo_files,
    "read_repo_file": read_repo_file,
    "search_code": search_code,
}

TOOL_SCHEMAS = {
    "get_server_metrics": _METRICS_SCHEMA,
    "get_alerts": _ALERTS_SCHEMA,
    "search_logs": _LOGS_SCHEMA,
    "get_service_status": GET_SERVICE_STATUS_SCHEMA,
    "get_disk_usage": GET_DISK_USAGE_SCHEMA,
    "get_running_processes": GET_RUNNING_PROCESSES_SCHEMA,
    "get_patch_status": _PATCH_SCHEMA,
    "list_pending_patches": LIST_PENDING_PATCHES_SCHEMA,
    "get_security_summary": _SECURITY_SUMMARY_SCHEMA,
    "list_top_vulnerabilities": _TOP_VULNS_SCHEMA,
    "list_containers": LIST_CONTAINERS_SCHEMA,
    "get_container_vulnerabilities": CONTAINER_VULNS_SCHEMA,
    "get_container_logs": CONTAINER_LOGS_SCHEMA,
    "get_container_env_keys": CONTAINER_ENV_KEYS_SCHEMA,
    "list_docker_networks": DOCKER_NETWORKS_SCHEMA,
    "get_network_traffic_summary": _NETWORK_SCHEMA,
    "list_available_playbooks": _PLAYBOOKS_SCHEMA,
    "web_fetch": _WEB_FETCH_SCHEMA,
    "web_search": _WEB_SEARCH_SCHEMA,
    "list_repo_files": LIST_FILES_SCHEMA,
    "read_repo_file": READ_FILE_SCHEMA,
    "search_code": SEARCH_CODE_SCHEMA,
    "restart_service": RESTART_SERVICE_SCHEMA,
    "run_ansible_job": RUN_ANSIBLE_JOB_SCHEMA,
    "reboot_host": REBOOT_HOST_SCHEMA,
    "run_shell_command": _SHELL_SCHEMA,
    "container_action": CONTAINER_ACTION_SCHEMA,
    "scan_host": SCAN_HOST_SCHEMA,
    "container_exec": CONTAINER_EXEC_SCHEMA,
}


def schemas_for(tool_names: list[str]) -> list[dict]:
    return [TOOL_SCHEMAS[name] for name in tool_names if name in TOOL_SCHEMAS]
