"""Enable the approved disk workflow for the Automation agent only."""
from alembic import op
from sqlalchemy import text
revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None
NOTE = "\nDisk growth: use expand_disk for ONE admin-approved workflow (default /data +50 GiB or explicit size). It includes free-VG checks, optional verified Proxmox growth, OS layers and final verification. Supply verified managed Proxmox node and VM ID if needed. Do not split it into shell-command approvals or claim success before the job verifies completion. Never retry an uncertain expansion as a new growth request."
def upgrade():
    op.execute(text("UPDATE ai_agents SET allowed_tools = allowed_tools || to_jsonb(CAST('expand_disk' AS text)), system_prompt = system_prompt || :note WHERE slug = 'automation' AND NOT allowed_tools @> jsonb_build_array('expand_disk')").bindparams(note=NOTE))
def downgrade():
    op.execute(text("UPDATE ai_agents SET allowed_tools = allowed_tools - 'expand_disk', system_prompt = replace(system_prompt, :note, '') WHERE slug = 'automation'").bindparams(note=NOTE))
