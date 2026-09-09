"""
Write/execute tools - restart_service, run_ansible_job, reboot_host,
run_shell_command.

Unlike every other tool in worker_ai/ai/tools/, calling one of these
during an agent run does NOT perform the action. worker_ai/ai/runtime.py
special-cases any tool name found in TOOL_APPROVAL_LEVEL (see that
module and worker_ai/ai/actions.py's request_approval) and creates a
pending AIAction row instead - these schemas exist so the LLM knows the
tools exist and what arguments they take, and EXECUTORS below is called
only after a human approves, from worker_ai/tasks.py's
execute_action_task. There is no code path where an agent's own tool-call
runs these directly.

playbook is a hard-coded enum, not free text - the LLM can only ever pick
one of the two named playbooks, matching the same "never let the model
generate the actual command" rule the rest of the app follows.
"""
from worker_ai.ansible_ops import run_ansible_query
from worker_ai.ai.tools.shell_tools import run_shell_command as _run_shell_command
from worker_ai.docker_ops import DOCKER_NAME_RE, docker_query

AI_EXECUTABLE_PLAYBOOKS = ("patch-security.yml", "patch-all.yml")
CONTAINER_ACTIONS = ("start", "stop", "restart")

TOOL_APPROVAL_LEVEL = {
    "restart_service": 2,
    "run_ansible_job": 2,
    "reboot_host": 3,
    # Always gated, regardless of what the command is - see shell_tools.py's
    # module docstring for why an earlier "only gate destructive-looking
    # commands" design was dropped in favor of always requiring approval.
    "run_shell_command": 3,
    "container_action": 2,
    "scan_host": 2,
    # Unrestricted execution, just scoped to inside a container instead of
    # the host - the same "always gated regardless of content" treatment
    # as run_shell_command, not the narrower container_action.
    "container_exec": 3,
}

TOOL_RISK = {
    "restart_service": "medium",
    "run_ansible_job": "medium",
    "reboot_host": "high",
    "run_shell_command": "high",
    "container_action": "medium",
    "scan_host": "low",
    "container_exec": "high",
}


def _label_restart_service(args: dict) -> str:
    return f"Restart {args.get('service')} on {args.get('hostname')}"


def _label_run_ansible_job(args: dict) -> str:
    return f"Run {args.get('playbook')} on {args.get('hostname')}"


def _label_reboot_host(args: dict) -> str:
    return f"Reboot {args.get('hostname')}"


def _label_run_shell_command(args: dict) -> str:
    command = str(args.get("command", ""))
    return f"Run shell command on {args.get('hostname')}: {command[:100]}"


def _label_container_action(args: dict) -> str:
    return f"{str(args.get('action', '')).capitalize()} container {args.get('name')} on {args.get('hostname')}"


def _label_scan_host(args: dict) -> str:
    return f"Run vulnerability scan on {args.get('hostname')}"


def _label_container_exec(args: dict) -> str:
    command = str(args.get("command", ""))
    return f"Run command in container {args.get('name')} on {args.get('hostname')}: {command[:100]}"


TOOL_ACTION_LABEL = {
    "restart_service": _label_restart_service,
    "run_ansible_job": _label_run_ansible_job,
    "reboot_host": _label_reboot_host,
    "run_shell_command": _label_run_shell_command,
    "container_action": _label_container_action,
    "scan_host": _label_scan_host,
    "container_exec": _label_container_exec,
}

CONTAINER_ACTION_SCHEMA = {
    "name": "container_action",
    "description": (
        "Requests starting, stopping or restarting one Docker container on a managed host. Does "
        "NOT run immediately - creates a pending approval request an operator must approve in "
        "Ops Center first. Tell the user it requires approval and give them the request code."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "name": {"type": "string", "description": "Container name"},
            "action": {"type": "string", "enum": list(CONTAINER_ACTIONS)},
        },
        "required": ["hostname", "name", "action"],
    },
}

SCAN_HOST_SCHEMA = {
    "name": "scan_host",
    "description": (
        "Requests a fresh vulnerability scan (installed-package inventory, correlated against "
        "the CVE feeds) of one managed host. Does NOT run immediately - creates a pending "
        "approval request an operator must approve first. Results land in the Security "
        "Intelligence page a few minutes after it runs, not in this conversation."
    ),
    "parameters": {"type": "object", "properties": {"hostname": {"type": "string"}}, "required": ["hostname"]},
}

CONTAINER_EXEC_SCHEMA = {
    "name": "container_exec",
    "description": (
        "Requests running one command inside a container (e.g. a curl to test outbound "
        "connectivity, or checking a config file) - for diagnosing a container-internal issue "
        "that get_container_logs/get_container_env_keys can't answer, like distinguishing an auth "
        "failure from a network failure. Unrestricted, like a shell inside the container - does "
        "NOT run immediately, creates a pending approval request an operator must approve first. "
        "Tell the user it requires approval and give them the request code."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "name": {"type": "string", "description": "Container name"},
            "command": {"type": "string", "description": "Shell command to run inside the container"},
        },
        "required": ["hostname", "name", "command"],
    },
}

RESTART_SERVICE_SCHEMA = {
    "name": "restart_service",
    "description": (
        "Requests restarting a systemd service on a managed host. This does NOT restart it "
        "immediately - it creates a pending approval request that an operator must approve in "
        "Ops Center before anything happens. Tell the user it requires approval and give them "
        "the request code."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "service": {"type": "string", "description": "systemd unit name, e.g. nginx"},
        },
        "required": ["hostname", "service"],
    },
}

RUN_ANSIBLE_JOB_SCHEMA = {
    "name": "run_ansible_job",
    "description": (
        "Requests running an approved patch playbook against a managed host. Does NOT run it "
        "immediately - creates a pending approval request an operator must approve first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "playbook": {"type": "string", "enum": list(AI_EXECUTABLE_PLAYBOOKS)},
        },
        "required": ["hostname", "playbook"],
    },
}

REBOOT_HOST_SCHEMA = {
    "name": "reboot_host",
    "description": (
        "Requests rebooting a managed host. High risk - does NOT reboot immediately, creates a "
        "pending approval request that requires an admin (not just an operator) to approve."
    ),
    "parameters": {
        "type": "object",
        "properties": {"hostname": {"type": "string"}},
        "required": ["hostname"],
    },
}


def execute_restart_service(arguments: dict) -> dict:
    return run_ansible_query(arguments["hostname"], "restart-service.yml", {"service_name": arguments["service"]})


def execute_run_ansible_job(arguments: dict) -> dict:
    playbook = arguments["playbook"]
    if playbook not in AI_EXECUTABLE_PLAYBOOKS:
        return {"available": False, "error": f"{playbook!r} is not an AI-executable playbook"}
    return run_ansible_query(arguments["hostname"], playbook, {})


def execute_reboot_host(arguments: dict) -> dict:
    return run_ansible_query(arguments["hostname"], "reboot.yml", {})


def execute_run_shell_command(arguments: dict) -> dict:
    return _run_shell_command(arguments["hostname"], arguments["command"])


def execute_container_action(arguments: dict) -> dict:
    name = str(arguments["name"])
    action = str(arguments["action"])
    if action not in CONTAINER_ACTIONS:
        return {"available": False, "error": f"{action!r} is not one of {CONTAINER_ACTIONS}"}
    if not DOCKER_NAME_RE.match(name):
        return {"available": False, "error": f"{name!r} is not a valid container name"}
    result = docker_query(
        arguments["hostname"],
        "security.tasks.container_action",
        [name, action],
        "container-control.yml",
        {"container_name": name, "container_action": action},
    )
    # security-worker reports {ok, message}; a false ok is a real failure
    if result.get("ok") is False:
        return {"available": False, "error": result.get("message") or f"{action} {name} failed"}
    return result


def execute_scan_host(arguments: dict) -> dict:
    return run_ansible_query(arguments["hostname"], "vulnerability-scan.yml", {})


def execute_container_exec(arguments: dict) -> dict:
    name = str(arguments["name"])
    command = str(arguments["command"])
    if not DOCKER_NAME_RE.match(name):
        return {"available": False, "error": f"{name!r} is not a valid container name"}
    result = docker_query(
        arguments["hostname"],
        "security.tasks.container_exec",
        [name, command],
        "container-exec.yml",
        {"container_name": name, "container_command": command},
    )
    if result.get("available") is False:
        return result
    if result.get("ok") is False:
        return {"available": False, "error": result.get("message") or "exec failed"}
    # normalizes the two possible successful shapes: local docker-py
    # (ok/exit_code/output) vs. remote ansible.builtin.command (rc/stdout/stderr)
    return {
        "available": True,
        "exit_code": result.get("exit_code", result.get("rc")),
        "output": (result.get("output", result.get("stdout")) or "")[:8000],
        "stderr": (result.get("stderr") or "")[:2000],
    }


EXECUTORS = {
    "restart_service": execute_restart_service,
    "run_ansible_job": execute_run_ansible_job,
    "reboot_host": execute_reboot_host,
    "run_shell_command": execute_run_shell_command,
    "container_action": execute_container_action,
    "scan_host": execute_scan_host,
    "container_exec": execute_container_exec,
}
