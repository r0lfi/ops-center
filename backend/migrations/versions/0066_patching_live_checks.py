"""Let the Patching agent verify pending updates and reboot need on the host itself.

run_diagnostic gained two read-only package checks (pending_updates,
reboot_required). Patching only read scan data, so it kept proposing a new
tool for exactly this. It now gets run_diagnostic, and its prompt and the
Coordinator's routing line say so. Prompt edits are text replacements that
leave a prompt an administrator already rewrote untouched (the note is then
appended instead).
"""
from alembic import op
from sqlalchemy import text

revision = "0066"
down_revision = "0065"
branch_labels = None
depends_on = None

OLD_PATCHING = ("When a question needs the live state on a host (pending security errata, whether a reboot is needed, "
                "the running kernel), say so in your answer so the Coordinator can ask the Linux agent, which runs "
                "read-only checks on hosts.")
NEW_PATCHING = ("For the live state on a host use run_diagnostic: pending_updates (pending updates and security advisories; "
                "on Debian/Proxmox the origin of each update) and reboot_required (running and installed kernels, "
                "needs-restarting). They are read-only and need no approval; say whether an answer comes from the host "
                "now or from the last scan.")
OLD_SOURCE = "Your data comes from the last scan or patch report, never from the host itself: always state its date."
NEW_SOURCE = "Scan and patch report data is as old as its date: always state it."
OLD_COORDINATOR = ("patching (patch state from the last scan and reports; live checks on a host, such as pending errata "
                   "or a needed reboot, go to linux)")
NEW_COORDINATOR = ("patching (patch state from scans and reports, and live on a host: pending and security updates, "
                   "reboot needed)")


def upgrade():
    op.execute(text(
        "UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST('run_diagnostic' AS text)) "
        "WHERE slug = 'patching' AND NOT allowed_tools @> jsonb_build_array('run_diagnostic')"))
    op.execute(text(
        "UPDATE ai_agents SET system_prompt = CASE WHEN strpos(system_prompt, :old) > 0 "
        "THEN replace(system_prompt, :old, :new) ELSE system_prompt || E'\\n' || :new END "
        "WHERE slug = 'patching' AND strpos(system_prompt, :new) = 0"
    ).bindparams(old=OLD_PATCHING, new=NEW_PATCHING))
    op.execute(text(
        "UPDATE ai_agents SET system_prompt = replace(system_prompt, :old, :new) WHERE slug = 'patching'"
    ).bindparams(old=OLD_SOURCE, new=NEW_SOURCE))
    op.execute(text(
        "UPDATE ai_agents SET system_prompt = replace(system_prompt, :old, :new) WHERE slug = 'coordinator'"
    ).bindparams(old=OLD_COORDINATOR, new=NEW_COORDINATOR))


def downgrade():
    op.execute(text("UPDATE ai_agents SET system_prompt = replace(system_prompt, :new, :old) WHERE slug = 'patching'")
               .bindparams(old=OLD_SOURCE, new=NEW_SOURCE))
    op.execute(text("UPDATE ai_agents SET allowed_tools = allowed_tools - 'run_diagnostic' WHERE slug = 'patching'"))
    op.execute(text("UPDATE ai_agents SET system_prompt = replace(system_prompt, :new, :old) WHERE slug = 'patching'")
               .bindparams(old=OLD_PATCHING, new=NEW_PATCHING))
    op.execute(text("UPDATE ai_agents SET system_prompt = replace(system_prompt, :new, :old) WHERE slug = 'coordinator'")
               .bindparams(old=OLD_COORDINATOR, new=NEW_COORDINATOR))
