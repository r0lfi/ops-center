import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

JOB_STATUSES = ("queued", "running", "successful", "failed", "cancelled")

# The only playbooks the API will ever submit - never an arbitrary path from
# the browser. Keep in sync with ansible/playbooks/.
ALLOWED_PLAYBOOKS = (
    "bootstrap.yml",
    "gather-facts.yml",
    "install-node-exporter.yml",
    "install-alloy.yml",
    "patch-check.yml",
    "patch-security.yml",
    "patch-all.yml",
    "reboot-check.yml",
    "reboot.yml",
    "vulnerability-scan.yml",
    "service-check.yml",
    "health-check.yml",
    "container-inventory.yml",
    "container-control.yml",
    "pihole-update.yml",
    "docker-images.yml",
    "docker-networks.yml",
    "docker-volumes.yml",
    "docker-logs.yml",
    "docker-stats.yml",
    "docker-inspect.yml",
    "docker-stack-deploy.yml",
    "docker-stack-remove.yml",
    "docker-stack-ps.yml",
    "docker-stack-action.yml",
    "docker-stack-list.yml",
    "docker-stack-get.yml",
    "docker-pull-image.yml",
    "docker-events.yml",
    "docker-discover-stacks.yml",
    # AI Operations layer (worker_ai/ai/tools/linux_tools.py) - read-only,
    # emits OPS_CENTER_QUERY_RESULT like the rest of the query-* entries above.
    "process-check.yml",
    # AI Operations layer, approval-gated write action (worker_ai/ai/tools/exec_tools.py) -
    # only ever submitted from execute_action_task, after human approval.
    "restart-service.yml",
    # General Agent's run_shell_command tool (worker_ai/ai/tools/shell_tools.py) -
    # deliberately unrestricted command execution; see that module's docstring
    # for the destructive-pattern/approval gate that sits in front of it.
    "run-shell-command.yml",
    # Containers Agent's container_exec tool (worker_ai/ai/tools/exec_tools.py) -
    # unrestricted execution scoped to inside one container; same always-approval-gated
    # treatment as run-shell-command.yml.
    "container-exec.yml",
)


class AnsibleJob(Base):
    __tablename__ = "ansible_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    user: Mapped[str | None] = mapped_column(String(100))  # real FK to users once Phase 10 auth lands
    playbook: Mapped[str] = mapped_column(String(100), nullable=False)
    target_description: Mapped[str] = mapped_column(String(500), nullable=False)
    limit: Mapped[str | None] = mapped_column(String(500))
    extra_vars: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued", index=True)
    celery_task_id: Mapped[str | None] = mapped_column(String(100), index=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    changed_hosts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    successful_hosts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_hosts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unreachable_hosts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Generic one-shot result passthrough for query-style playbooks
    # (docker-images.yml etc.) that need to hand a JSON answer back to
    # whichever API request submitted them - see worker/tasks.py's
    # QUERY_MARKER. Unused (stays NULL) for action/patch/scan playbooks,
    # which have their own dedicated storage (containers/patches/etc tables).
    result_payload: Mapped[dict | None] = mapped_column(JSONB)

    events: Mapped[list["AnsibleEvent"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="AnsibleEvent.sequence"
    )


class AnsibleEvent(Base):
    __tablename__ = "ansible_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid()
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ansible_jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    host: Mapped[str | None] = mapped_column(String(255))
    task: Mapped[str | None] = mapped_column(String(500))
    message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    job: Mapped[AnsibleJob] = relationship(back_populates="events")
