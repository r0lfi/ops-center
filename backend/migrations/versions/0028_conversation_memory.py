"""Conversation memory: ai_tasks.conversation_key

Groups a sequence of AITask rows into one conversation (a Talk room, a
chat-page thread) so a follow-up question can see what was actually said
before - see worker_ai/tasks.py's _build_contextual_message. Previously
every task, Talk included, started with zero history, which is why asking
the Coordinator a follow-up in Talk ("which two findings?") drew a blank -
it had genuinely never seen the earlier message.

Revision ID: 0028
Revises: 0027
Create Date: 2026-09-06

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: Union[str, None] = "0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("ai_tasks", sa.Column("conversation_key", sa.String(200), nullable=True))
    op.create_index("ix_ai_tasks_conversation_key", "ai_tasks", ["conversation_key"])


def downgrade() -> None:
    op.drop_index("ix_ai_tasks_conversation_key", table_name="ai_tasks")
    op.drop_column("ai_tasks", "conversation_key")
