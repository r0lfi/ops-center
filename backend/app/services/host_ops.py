"""
Shared local/remote host-operation helpers.

Originally lived only in app/api/routes/containers.py; extracted so the AI
tool layer (app/services/ai/tools/*.py) calls exactly the same code paths
as the existing Docker Hosts UI instead of a second implementation -
"controlled tools" wrap real service code, they don't reinvent it.

Local host (settings.ops_local_hostname) actions go straight to
security-worker over Celery (it's the only component with docker.sock -
see security/docker_control.py). Everything else - remote hosts, and any
read-only "ask a host something" query that isn't Docker-specific -
goes through an Ansible playbook submitted the same way the rest of the
app submits playbooks (a queued AnsibleJob + worker.tasks.run_playbook),
polled to a terminal state so callers get a blocking, immediate result.
"""
import asyncio

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.host import Host
from app.models.job import AnsibleJob
from app.services.celery_client import get_celery_client

_REMOTE_ACTION_POLL_TIMEOUT = 45


def _send_and_wait_sync(task_name: str, args: list, timeout: int):
    # Routed to THIS node's own security-worker specifically, not the
    # shared "security" queue - since Phase 3 (2026-09-06) both
    # ops-host and docker-host-02 run their own security-worker against
    # a shared Redis/Sentinel broker, a plain "security" queue means
    # either host's worker can grab the task, but only the local one has
    # the matching docker.sock. Every send_and_wait() caller is inherently
    # a "my own local host" action by construction (see module docstring),
    # so the host-specific queue is always correct here.
    celery = get_celery_client()
    queue = f"security.{get_settings().ops_local_hostname}"
    async_result = celery.send_task(task_name, args=args, queue=queue)
    return async_result.get(timeout=timeout)


async def send_and_wait(task_name: str, args: list, timeout: int):
    # celery's .get() blocks synchronously - run it off the event loop so a
    # slow call doesn't stall every other concurrent request ops-api is
    # serving.
    try:
        return await asyncio.to_thread(_send_and_wait_sync, task_name, args, timeout)
    except TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail=f"{task_name} did not finish within {timeout}s - it may still be running on security-worker",
        ) from exc


async def get_host_by_hostname(db: AsyncSession, hostname: str) -> Host:
    host = (await db.execute(select(Host).where(Host.hostname == hostname))).scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail=f"no managed host named {hostname!r}")
    return host


async def run_remote_query(
    db: AsyncSession, host: Host, playbook: str, extra_vars: dict, poll_timeout: int = _REMOTE_ACTION_POLL_TIMEOUT
) -> dict:
    """
    Submit a read-only "ask a host something" playbook and poll the
    resulting AnsibleJob to a terminal state, returning its result_payload
    (populated by worker/tasks.py's QUERY_MARKER handling) instead of a
    bare ok/message. poll_timeout is overridable for slower operations.
    """
    job = AnsibleJob(
        playbook=playbook,
        target_description=f"{playbook} on {host.hostname}",
        extra_vars=extra_vars,
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook",
        args=[str(job.id), [str(host.id)], playbook, None, extra_vars],
    )

    job_id = job.id
    for _ in range(poll_timeout):
        await asyncio.sleep(1)
        await db.refresh(job)
        if job.status in ("successful", "failed", "cancelled"):
            break
    else:
        raise HTTPException(
            status_code=504,
            detail=f"{playbook} is still running on {host.hostname} after "
            f"{poll_timeout}s - check Jobs for job {job_id}",
        )

    if job.status != "successful":
        raise HTTPException(
            status_code=502,
            detail=f"{playbook} failed on {host.hostname} - see Jobs (job {job_id}) for the SSH/docker output",
        )
    return job.result_payload or {}
