"""Teach Coordinator to escalate to General Agent instead of saying "do it manually"

Real incident: asked (via Talk) to fix a Watchtower label and test Brevo
connectivity, the Coordinator dispatched to Container and Automation,
got back honest "I don't have a tool for this" answers (true - neither
agent has host-level shell or curl), and then relayed that as a final
answer telling the user to SSH in and do it by hand themselves. That's
wrong: the General Agent already has full (approval-gated) SSH shell
access to every host and can do both - editing a compose file and
recreating a container, or running a one-off curl - the Coordinator just
never considered it as a fallback. This is a routing gap, not a missing
tool (see 0031_chat_agent.py for the same class of fix, applied there to
general-knowledge questions instead of host-level actions).

Revision ID: 0032
Revises: 0031
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision: Union[str, None] = "0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ADDENDUM = (
    " If a specialist agent reports it lacks the right tool for a "
    "host-level action - editing a file, recreating a container, running "
    "an arbitrary command like curl for a connectivity test - do not tell "
    "the user to do it manually. Dispatch to the general agent instead: "
    "it has full (human-approved) SSH shell access to every managed host "
    "and can do things no narrower specialist agent can. Only tell the "
    "user something must be done by hand if the general agent's own "
    "run_shell_command genuinely can't reach it either."
)


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE ai_agents SET system_prompt = system_prompt || CAST(:addendum AS text) "
            "WHERE slug = 'coordinator' AND system_prompt NOT LIKE '%Dispatch to the general agent instead%'"
        ).bindparams(addendum=_ADDENDUM)
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE ai_agents SET system_prompt = replace(system_prompt, CAST(:addendum AS text), '') "
            "WHERE slug = 'coordinator'"
        ).bindparams(addendum=_ADDENDUM)
    )
