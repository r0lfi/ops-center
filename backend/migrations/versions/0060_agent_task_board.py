"""Coordinated investigations: task board, shared findings, tool proposals.

* ai_work_items: the coordinator's board of delegated subtasks (status,
  dependencies, result). Written as each delegation starts and ends, so it
  is the checkpoint a resumed investigation continues from.
* ai_findings gains kind/system/source/owner/fingerprint/observed_at/
  stale_after: shared operational memory written by record_finding. The
  table existed but nothing wrote to it.
* ai_tool_proposals: missing capabilities agents report for human review.
* ai_tasks.outcome / resumed_from.
* Role prompts: one short prompt per agent. The shared rules live in code
  (worker_ai/ai/policy.py), so they are no longer copied into every row.
  The old "prefer ops_* MCP tools" text is removed: MCP tools are offered
  only while a grant is live.
* Coordinator: 900 s (specialists inherit its deadline) and an explicit
  delegation list, so the new developer agent is never a dispatch target.
* developer agent: reads the repository and submits a patch for an
  approved proposal; no shell, no infrastructure tools.

Downgrade restores the previous prompts, limits and dispatch targets.

Revision ID: 0060
Revises: 0059
Create Date: 2026-11-13
"""
import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None

DEVELOPER_ID = "20000000-0000-0000-0000-000000000011"
MISTRAL_PROVIDER = "10000000-0000-0000-0000-000000000004"
SPECIALISTS = ["monitoring", "network", "linux", "container", "security", "patching", "automation", "general", "chat"]

PROMPTS = {
    "coordinator": (
        "You are the Coordinator, the user's single entry point to Ops Center. You lead investigations; specialists do the hands-on checks.\n"
        "1. Restate the problem as concrete questions and check recall_memory for earlier investigations and findings.\n"
        "2. Plan with plan_work: one item per independent question, the right specialist, and depends_on only where an item needs another's result. "
        "Specialists: monitoring (Prometheus, Alertmanager, Loki), network (traffic edge, DNS, HTTP/TLS from hosts), linux (services, disks, processes, journal), "
        "container (Docker state, logs), security (vulnerabilities, findings), patching (patch state), automation (playbooks), "
        "general (repository, web, approval-gated shell when no narrower tool fits), chat (general knowledge, small talk).\n"
        "3. Dispatch each item with dispatch_to_agent and its work_item id. Independent items dispatched in the same turn run in parallel.\n"
        "4. Read every result. When it is partial, inconclusive or raises a new question, send one focused follow-up (to the same or another specialist) instead of stopping. "
        "Never send the same question to the same agent twice.\n"
        "5. Answer with: cause (or what is still unknown), evidence with sources, recommended action, approvals needed, and open items. "
        "Present any tool proposal an agent made. If the evidence does not prove the cause, say so."
    ),
    "monitoring": (
        "You are the Monitoring agent: Prometheus metrics, Alertmanager alerts and Loki logs, plus read-only host diagnostics.\n"
        "Search logs narrowly (host, search text, short time range) and widen only when needed; results are aggregated, with the LogQL query for the raw lines. "
        "Correlate a symptom with metrics and alerts before naming a cause. Record confirmed facts and ruled-out hypotheses with record_finding."
    ),
    "network": (
        "You are the Network agent: traffic at the edge (Traffic Map), DNS, HTTP and TLS reachability, Docker networks and peers.\n"
        "Use run_diagnostic from the relevant host: dns_lookup, http_check (status, time, remote IP, redirect target) and tls_check (SNI, certificate, verify errors; ip pins one endpoint). "
        "An HTTP 3xx shows only that something answered: follow the redirect target. A TLS error such as 'unrecognized name' points at SNI or the proxy's host configuration: "
        "compare the public endpoint with the backend (tls_check with ip) and check certificate names and dates."
    ),
    "linux": (
        "You are the Linux agent: RHEL, AlmaLinux and Ubuntu host health - services, failed units, disks, memory, processes, listening ports and the journal.\n"
        "Prefer run_diagnostic and the read tools; restart_service, reboot_host and run_ansible_job only create approval requests. "
        "get_patch_status reads the last scan on file: say when it ran."
    ),
    "container": (
        "You are the Container agent: Docker containers, images, networks, logs and vulnerabilities on managed hosts.\n"
        "Check container state, restart counts, health and recent logs before suggesting a change. container_action and container_exec only create approval requests."
    ),
    "security": (
        "You are the Security agent: vulnerability findings, advisories, security summaries and suspicious traffic.\n"
        "Rank by exploitability and exposure, cite the scan date, and say when data is missing or old. scan_host only creates an approval request."
    ),
    "patching": (
        "You are the Patching agent: patch status, pending updates and patch reports.\n"
        "Data comes from the last scan or report: always state its date. run_ansible_job only creates an approval request."
    ),
    "automation": (
        "You are the Automation agent: the reviewed Ansible playbook library and job history.\n"
        "Pick the playbook that matches the need, explain what it changes, and check recent jobs for earlier runs. run_ansible_job and expand_disk only create approval requests."
    ),
    "general": (
        "You are the General agent: the Ops Center repository, the web, and host-level work no narrower specialist covers.\n"
        "Use run_diagnostic for reading a host. run_shell_command is approval-gated: request it only when no read tool can answer, with one exact command and why. "
        "For questions about how Ops Center works, read the code instead of guessing."
    ),
    "chat": (
        "You are the Chat agent for general knowledge and conversation that is not about this infrastructure. "
        "Use web_search and web_fetch for current facts and cite the source. Hand infrastructure questions back to the Coordinator."
    ),
}

DEVELOPER_PROMPT = (
    "You are the Developer agent. You implement one approved tool proposal for Ops Center as a patch.\n"
    "Read the relevant code first (list_repo_files, search_code, read_repo_file) and reuse existing patterns: tools live in worker_ai/ai/tools, "
    "are registered in worker_ai/ai/tools/__init__.py, write tools only create approval requests, and every new read must validate its arguments. "
    "Write the smallest change that works, with tests under worker_ai/tests. Submit it once with submit_patch as a unified diff against the repository root, "
    "with notes on security, required permissions and how it was meant to be tested. You cannot run code; say what still needs verification."
)


def upgrade():
    op.add_column("ai_tasks", sa.Column("outcome", sa.String(30)))
    op.add_column("ai_tasks", sa.Column("resumed_from", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")))
    op.add_column("ai_findings", sa.Column("kind", sa.String(20), nullable=False, server_default="fact"))
    op.add_column("ai_findings", sa.Column("system", sa.String(200)))
    op.add_column("ai_findings", sa.Column("source", sa.String(100)))
    op.add_column("ai_findings", sa.Column("owner_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")))
    op.add_column("ai_findings", sa.Column("fingerprint", sa.String(64), unique=True))
    op.add_column("ai_findings", sa.Column("observed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.add_column("ai_findings", sa.Column("stale_after", sa.DateTime(timezone=True)))
    op.create_index("ix_ai_findings_system", "ai_findings", ["system"])
    op.create_table(
        "ai_work_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("agent_slug", sa.String(50), nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("status", sa.String(30), nullable=False, server_default="queued"),
        sa.Column("depends_on", JSONB, nullable=False, server_default="[]"),
        sa.Column("result", sa.Text),
        sa.Column("tools", JSONB, nullable=False, server_default="[]"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "ai_tool_proposals",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL"), index=True),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("ai_agents.id", ondelete="SET NULL")),
        sa.Column("owner_user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("details", JSONB, nullable=False, server_default="{}"),
        sa.Column("status", sa.String(30), nullable=False, server_default="proposed", index=True),
        sa.Column("patch", sa.Text),
        sa.Column("patch_notes", sa.Text),
        sa.Column("dev_task_id", UUID(as_uuid=True), sa.ForeignKey("ai_tasks.id", ondelete="SET NULL")),
        sa.Column("decided_by", sa.String(100)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    bind = op.get_bind()
    previous = {row.slug: {"system_prompt": row.system_prompt, "max_execution_seconds": row.max_execution_seconds,
                           "allowed_dispatch_targets": row.allowed_dispatch_targets}
                for row in bind.execute(sa.text("SELECT slug, system_prompt, max_execution_seconds, allowed_dispatch_targets FROM ai_agents WHERE slug = ANY(:s)"),
                                        {"s": list(PROMPTS)})}
    # Kept so downgrade restores exactly what was there, including hand edits.
    op.create_table("ai_agent_prompt_backup_0060", sa.Column("slug", sa.String(50), primary_key=True), sa.Column("data", JSONB, nullable=False))
    for slug, data in previous.items():
        bind.execute(sa.text("INSERT INTO ai_agent_prompt_backup_0060 (slug, data) VALUES (:slug, CAST(:data AS jsonb))"),
                     {"slug": slug, "data": json.dumps(data)})
    for slug, prompt in PROMPTS.items():
        bind.execute(sa.text("UPDATE ai_agents SET system_prompt = :p WHERE slug = :slug"), {"p": prompt, "slug": slug})
    bind.execute(sa.text("UPDATE ai_agents SET max_execution_seconds = GREATEST(max_execution_seconds, 900), "
                         "allowed_dispatch_targets = CAST(:t AS jsonb) WHERE slug = 'coordinator'"),
                 {"t": json.dumps(SPECIALISTS)})
    provider = bind.execute(sa.text("SELECT provider_id FROM ai_agents WHERE slug = 'coordinator'")).scalar()
    bind.execute(sa.text(
        "INSERT INTO ai_agents (id, slug, name, description, responsibility, status, provider_id, system_prompt, allowed_tools, "
        "allowed_hosts, allowed_environments, autonomy_level, max_tool_calls, max_execution_seconds, enabled, runtime, personal) "
        "VALUES (CAST(:id AS uuid), 'developer', 'Developer Agent', 'Implements approved tool proposals as reviewable patches.', "
        "'Turns an approved tool proposal into a tested patch; never deploys or runs code.', 'idle', :provider, :prompt, "
        "CAST(:tools AS jsonb), '[]'::jsonb, '[]'::jsonb, 0, 40, 900, true, 'native', false) ON CONFLICT (slug) DO NOTHING"
    ), {"id": DEVELOPER_ID, "provider": provider or MISTRAL_PROVIDER, "prompt": DEVELOPER_PROMPT,
        "tools": json.dumps(["list_repo_files", "read_repo_file", "search_code"])})


def downgrade():
    bind = op.get_bind()
    for slug, data in bind.execute(sa.text("SELECT slug, data FROM ai_agent_prompt_backup_0060")):
        bind.execute(sa.text("UPDATE ai_agents SET system_prompt = :p, max_execution_seconds = :m, "
                             "allowed_dispatch_targets = CAST(:t AS jsonb) WHERE slug = :slug"),
                     {"p": data["system_prompt"], "m": data["max_execution_seconds"],
                      "t": json.dumps(data["allowed_dispatch_targets"]) if data["allowed_dispatch_targets"] is not None else None, "slug": slug})
    bind.execute(sa.text("DELETE FROM ai_agents WHERE id = CAST(:id AS uuid) AND NOT EXISTS (SELECT 1 FROM ai_tasks WHERE agent_id = CAST(:id AS uuid))"),
                 {"id": DEVELOPER_ID})
    op.drop_table("ai_agent_prompt_backup_0060")
    op.drop_table("ai_tool_proposals")
    op.drop_table("ai_work_items")
    op.drop_index("ix_ai_findings_system", table_name="ai_findings")
    for column in ("stale_after", "observed_at", "fingerprint", "owner_user_id", "source", "system", "kind"):
        op.drop_column("ai_findings", column)
    op.drop_column("ai_tasks", "resumed_from")
    op.drop_column("ai_tasks", "outcome")
