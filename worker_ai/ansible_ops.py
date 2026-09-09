"""
Read-only "ask a host something over Ansible" helper for AI tools.

Sync sibling of app/services/host_ops.py's run_remote_query - same submit-
a-playbook-and-poll-to-terminal pattern (a queued AnsibleJob +
worker.tasks.run_playbook, polled via a plain SessionLocal), just blocking
instead of async since worker_ai's tasks are plain Celery (sync) code.
Always goes through Ansible, even for the local host (ops-host) - the
Linux Agent's tools are about generic Linux facts Ansible already gathers
for every managed host, not Docker-socket operations, so there's no
local/security-worker branch to make here (unlike containers.py).
"""
import time

from sqlalchemy import select

from app.models.host import Host
from app.models.job import AnsibleJob
from worker_ai.celery_client import get_celery_client
from worker_ai.db import SessionLocal

POLL_TIMEOUT_SECONDS = 45


def run_ansible_query(hostname: str, playbook: str, extra_vars: dict) -> dict:
    with SessionLocal() as db:
        host = db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none()
        if host is None:
            return {"available": False, "error": f"no managed host named {hostname!r}"}

        job = AnsibleJob(
            playbook=playbook,
            target_description=f"{playbook} on {hostname} (AI tool)",
            extra_vars=extra_vars,
            status="queued",
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        get_celery_client().send_task(
            "worker.tasks.run_playbook",
            args=[str(job.id), [str(host.id)], playbook, None, extra_vars],
        )

        job_id = job.id
        for _ in range(POLL_TIMEOUT_SECONDS):
            time.sleep(1)
            db.refresh(job)
            if job.status in ("successful", "failed", "cancelled"):
                break
        else:
            return {
                "available": False,
                "error": f"{playbook} is still running on {hostname} after {POLL_TIMEOUT_SECONDS}s (job {job_id})",
            }

        if job.status != "successful":
            return {"available": False, "error": f"{playbook} failed on {hostname} (see Jobs, job {job_id})"}

        return {"available": True, **(job.result_payload or {})}
