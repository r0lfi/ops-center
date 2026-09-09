"""Add Security, Containers, Patching, Network, and Automation agents

Fills in the 5 remaining Ops Floor stations that were previously visual
placeholders only (no backend agent existed for them). Each is scoped to
real, already-existing tools - see worker_ai/ai/tools/{security,container,
network,automation}_tools.py and patch_tools.py's new list_pending_patches -
no fabricated capability. Containers and Network are read-only for now:
neither has a write/execute tool yet (see those tools' docstrings for why).
Patching and Automation both get run_ansible_job, the same always-approval-
gated tool the Linux/General agents already have, still limited to
AI_EXECUTABLE_PLAYBOOKS (patch-security.yml/patch-all.yml).

Revision ID: 0026
Revises: 0025
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PROVIDER_ANTHROPIC = "10000000-0000-0000-0000-000000000001"

AGENT_SECURITY = "20000000-0000-0000-0000-000000000005"
AGENT_CONTAINER = "20000000-0000-0000-0000-000000000006"
AGENT_PATCHING = "20000000-0000-0000-0000-000000000007"
AGENT_NETWORK = "20000000-0000-0000-0000-000000000008"
AGENT_AUTOMATION = "20000000-0000-0000-0000-000000000009"

_SECURITY_PROMPT = (
    "You are the Security Agent for Ops Center. You investigate vulnerability and CVE exposure "
    "across managed hosts and containers using only your tools: get_security_summary, "
    "list_top_vulnerabilities, and get_alerts. Never state a vulnerability count, CVE, or "
    "priority level unless a tool call just returned it. If a tool reports unavailable, say so "
    "plainly rather than guessing."
)
_CONTAINER_PROMPT = (
    "You are the Containers Agent for Ops Center. You investigate Docker container health across "
    "managed hosts using only your tools: list_containers, get_container_vulnerabilities, and "
    "get_alerts. You can report container status, health, and known CVEs, but you cannot start, "
    "stop, or restart a container yet - tell the user that requires the Containers page. Never "
    "state a container's status or vulnerabilities unless a tool call just returned it."
)
_PATCHING_PROMPT = (
    "You are the Patching Agent for Ops Center. You investigate and act on OS package updates "
    "across managed hosts using your tools: get_patch_status (one host), list_pending_patches "
    "(fleet-wide), and run_ansible_job (installs patch-security.yml or patch-all.yml - this "
    "creates a pending approval request an operator must approve first, it never runs "
    "immediately). Never state a host's patch status unless a tool call just returned it."
)
_NETWORK_PROMPT = (
    "You are the Network Agent for Ops Center. You investigate inbound traffic at the network "
    "edge (the Traffic Map feed) using your tools: get_network_traffic_summary and get_alerts. "
    "Never state a traffic pattern, client country, or suspicious-request count unless a tool "
    "call just returned it. If no Traffic Map data has been published yet, say so plainly."
)
_AUTOMATION_PROMPT = (
    "You are the Automation Agent for Ops Center. You help operators understand and trigger "
    "Ansible automation using your tools: list_available_playbooks and run_ansible_job (limited "
    "to patch-security.yml/patch-all.yml - this creates a pending approval request an operator "
    "must approve first, it never runs immediately). For any other playbook, tell the user to run "
    "it from the Automation page. Never state a playbook exists unless list_available_playbooks "
    "just confirmed it."
)


def upgrade() -> None:
    agents_table = sa.table(
        "ai_agents",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("slug", sa.String),
        sa.column("name", sa.String),
        sa.column("description", sa.Text),
        sa.column("responsibility", sa.Text),
        sa.column("status", sa.String),
        sa.column("provider_id", postgresql.UUID(as_uuid=True)),
        sa.column("system_prompt", sa.Text),
        sa.column("allowed_tools", postgresql.JSONB),
        sa.column("allowed_hosts", postgresql.JSONB),
        sa.column("allowed_environments", postgresql.JSONB),
        sa.column("autonomy_level", sa.Integer),
        sa.column("max_tool_calls", sa.Integer),
        sa.column("max_execution_seconds", sa.Integer),
        sa.column("enabled", sa.Boolean),
    )
    op.bulk_insert(
        agents_table,
        [
            {
                "id": AGENT_SECURITY,
                "slug": "security",
                "name": "Security Agent",
                "description": "Vulnerability and CVE exposure across managed hosts and containers.",
                "responsibility": "Vulnerability counts, CVE priority ranking, security advisories.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _SECURITY_PROMPT,
                "allowed_tools": ["get_security_summary", "list_top_vulnerabilities", "get_alerts"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
            {
                "id": AGENT_CONTAINER,
                "slug": "container",
                "name": "Containers Agent",
                "description": "Docker container status, health, and vulnerabilities across managed hosts.",
                "responsibility": "Container inventory, health/status, and image CVEs.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _CONTAINER_PROMPT,
                "allowed_tools": ["list_containers", "get_container_vulnerabilities", "get_alerts"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
            {
                "id": AGENT_PATCHING,
                "slug": "patching",
                "name": "Patching Agent",
                "description": "OS package update status across the fleet, and requesting security patch runs.",
                "responsibility": "Pending patch counts, reboot-required flags, and requesting patch installs.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _PATCHING_PROMPT,
                "allowed_tools": ["get_patch_status", "list_pending_patches", "run_ansible_job"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
            {
                "id": AGENT_NETWORK,
                "slug": "network",
                "name": "Network Agent",
                "description": "Inbound edge traffic from the Traffic Map feed (edge-host and the home reverse proxy).",
                "responsibility": "Traffic volume, client geography, and suspicious (4xx/5xx) requests.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _NETWORK_PROMPT,
                "allowed_tools": ["get_network_traffic_summary", "get_alerts"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
            {
                "id": AGENT_AUTOMATION,
                "slug": "automation",
                "name": "Automation Agent",
                "description": "What Ansible automation exists, and requesting patch playbook runs.",
                "responsibility": "Playbook discovery and requesting patch-security.yml/patch-all.yml runs.",
                "status": "idle",
                "provider_id": PROVIDER_ANTHROPIC,
                "system_prompt": _AUTOMATION_PROMPT,
                "allowed_tools": ["list_available_playbooks", "run_ansible_job", "get_alerts"],
                "allowed_hosts": [],
                "allowed_environments": [],
                "autonomy_level": 0,
                "max_tool_calls": 8,
                "max_execution_seconds": 90,
                "enabled": True,
            },
        ],
    )


def downgrade() -> None:
    ids = ", ".join(
        f"'{i}'" for i in (AGENT_SECURITY, AGENT_CONTAINER, AGENT_PATCHING, AGENT_NETWORK, AGENT_AUTOMATION)
    )
    op.execute(f"DELETE FROM ai_agents WHERE id IN ({ids})")
