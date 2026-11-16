"""Grant the read-only run_diagnostic tool to the agents that inspect hosts.

The General agent's only host tool was run_shell_command (always approval-
gated), so plain reads like df/docker ps became level-3 approvals. The note
steers it to run_diagnostic for reads and keeps shell for everything else.
"""
from alembic import op
from sqlalchemy import text

revision = "0048"
down_revision = "0047"
branch_labels = None
depends_on = None

SLUGS = ("general", "linux", "container", "network", "monitoring")
NOTE = (
    "\nHost inspection: use run_diagnostic for read-only checks (disk, LVM, mounts, memory, "
    "processes, systemd status/journal, ports, docker ps/logs/inspect/stats, HTTP and DNS "
    "checks). It runs immediately without approval. Use run_shell_command only when no "
    "run_diagnostic check covers the need or when something must be changed; that still "
    "requires human approval."
)


def upgrade():
    op.execute(text(
        "UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST('run_diagnostic' AS text)) "
        "WHERE slug = ANY(:slugs) AND NOT allowed_tools @> jsonb_build_array('run_diagnostic')"
    ).bindparams(slugs=list(SLUGS)))
    op.execute(text(
        "UPDATE ai_agents SET system_prompt = system_prompt || :note "
        "WHERE slug = 'general' AND strpos(system_prompt, :note) = 0"
    ).bindparams(note=NOTE))


def downgrade():
    op.execute(text(
        "UPDATE ai_agents SET allowed_tools = allowed_tools - 'run_diagnostic', "
        "system_prompt = replace(system_prompt, :note, '') WHERE slug = ANY(:slugs)"
    ).bindparams(note=NOTE, slugs=list(SLUGS)))
