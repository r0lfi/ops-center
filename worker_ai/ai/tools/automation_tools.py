"""
list_available_playbooks tool for the Automation Agent.

Just returns the same fixed allowlist the Automation page's playbook
picker uses (app.models.job.ALLOWED_PLAYBOOKS). This agent can only
trigger patch-security.yml/patch-all.yml itself, via run_ansible_job (same
as every other agent with that tool - see exec_tools.py's
AI_EXECUTABLE_PLAYBOOKS) - the rest of ALLOWED_PLAYBOOKS require a human
to run them from the Automation page. This tool exists so it can tell a
user what playbooks exist, not to expand what it can trigger.
"""
from app.models.job import ALLOWED_PLAYBOOKS

TOOL_SCHEMA = {
    "name": "list_available_playbooks",
    "description": (
        "Every Ansible playbook the Automation page can run manually against a host, hosts, or "
        "group. This agent can only trigger patch-security.yml/patch-all.yml itself (via "
        "run_ansible_job, which still requires human approval) - everything else in this list "
        "requires a human to run it from the Automation page."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def list_available_playbooks() -> dict:
    return {"available": True, "playbooks": sorted(ALLOWED_PLAYBOOKS)}
