"""ansible_jobs, ansible_events

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID_DEFAULT = sa.text("gen_random_uuid()")


def upgrade() -> None:
    op.create_table(
        "ansible_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column("user", sa.String(100)),
        sa.Column("playbook", sa.String(100), nullable=False),
        sa.Column("target_description", sa.String(500), nullable=False),
        sa.Column("limit", sa.String(500)),
        sa.Column("extra_vars", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(20), nullable=False, server_default="queued"),
        sa.Column("celery_task_id", sa.String(100)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("changed_hosts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("successful_hosts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_hosts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unreachable_hosts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ansible_jobs_status", "ansible_jobs", ["status"])
    op.create_index("ix_ansible_jobs_celery_task_id", "ansible_jobs", ["celery_task_id"])

    op.create_table(
        "ansible_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=UUID_DEFAULT),
        sa.Column(
            "job_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ansible_jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("host", sa.String(255)),
        sa.Column("task", sa.String(500)),
        sa.Column("message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_ansible_events_job_id", "ansible_events", ["job_id"])


def downgrade() -> None:
    op.drop_table("ansible_events")
    op.drop_index("ix_ansible_jobs_celery_task_id", table_name="ansible_jobs")
    op.drop_index("ix_ansible_jobs_status", table_name="ansible_jobs")
    op.drop_table("ansible_jobs")
