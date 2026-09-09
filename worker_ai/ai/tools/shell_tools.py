"""
run_shell_command - real shell access for the General Agent.

Reuses the exact same SSH connectivity every other host operation in Ops
Center already uses (Ansible, host-key pinning, the same Credential rows
- see run-shell-command.yml) rather than provisioning a separate SSH
identity for this agent. "Same reach as an operator already has", not a
new access path.

Always approval-gated (see exec_tools.py's TOOL_APPROVAL_LEVEL / runtime.py's
dispatch loop) - every command requires a human to approve it before it
runs, same as restart_service/run_ansible_job/reboot_host. An earlier
version of this tool tried to run non-destructive-looking commands
immediately and only gate ones matching a dangerous-pattern list;
deliberately dropped in favor of "always ask" - a heuristic pattern list
is a best-effort safety net at best, and for a tool with this much reach
that was judged not good enough on its own.
"""
from worker_ai.ansible_ops import run_ansible_query

TOOL_SCHEMA = {
    "name": "run_shell_command",
    "description": (
        "Requests running a shell command on a managed host over SSH (as root, via the same "
        "connectivity every other Ops Center host operation uses). This does NOT run immediately - "
        "every command, regardless of how safe it looks, creates a pending approval request that "
        "an operator must approve in Ops Center first. Tell the user it requires approval and give "
        "them the request code. This is a powerful, general-purpose tool with real production "
        "impact - prefer proposing read-only investigation commands (ls, cat, systemctl status, "
        "journalctl, ps, df, grep, curl, ...) and explain what a command will do."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "command": {"type": "string", "description": "The shell command to run"},
        },
        "required": ["hostname", "command"],
    },
}


def run_shell_command(hostname: str, command: str) -> dict:
    """The real executor - only ever called from execute_action_task, after
    a human has approved the request this tool's call created."""
    return run_ansible_query(hostname, "run-shell-command.yml", {"shell_command": command})
