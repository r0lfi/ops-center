from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import Host, HostGroup
from app.models.job import ALLOWED_PLAYBOOKS, AnsibleJob
from app.schemas.job import AnsibleJobRead, AutomationRunRequest
from app.services.automation import build_extra_vars
from app.services.celery_client import get_celery_client

router = APIRouter()


@router.get("/automation/playbooks")
async def list_playbooks() -> list[str]:
    return list(ALLOWED_PLAYBOOKS)


@router.post("/automation/run", response_model=AnsibleJobRead, status_code=201, dependencies=[Depends(require_role("operator"))])
async def run_automation(
    payload: AutomationRunRequest, db: AsyncSession = Depends(get_db)
) -> AnsibleJob:
    if payload.playbook not in ALLOWED_PLAYBOOKS:
        raise HTTPException(status_code=422, detail=f"playbook must be one of {ALLOWED_PLAYBOOKS}")

    if payload.target_type == "host":
        if payload.host_id is None:
            raise HTTPException(status_code=422, detail="host_id is required for target_type=host")
        query = select(Host).where(Host.id == payload.host_id)
        target_description = f"host:{payload.host_id}"
    elif payload.target_type == "hosts":
        if not payload.host_ids:
            raise HTTPException(status_code=422, detail="host_ids is required for target_type=hosts")
        query = select(Host).where(Host.id.in_(payload.host_ids))
        target_description = f"hosts:{len(payload.host_ids)} selected"
    elif payload.target_type == "group":
        if payload.group_id is None:
            raise HTTPException(status_code=422, detail="group_id is required for target_type=group")
        query = select(Host).join(Host.groups).where(HostGroup.id == payload.group_id)
        target_description = f"group:{payload.group_id}"
    else:
        raise HTTPException(status_code=422, detail="target_type must be one of host, hosts, group")

    hosts = (await db.execute(query)).scalars().all()
    if not hosts:
        raise HTTPException(status_code=422, detail="no matching hosts found for the given target")

    if payload.target_type in ("host", "group"):
        target_description = f"{target_description} ({', '.join(h.hostname for h in hosts)})"

    extra_vars = build_extra_vars(payload.playbook, payload)

    job = AnsibleJob(
        playbook=payload.playbook,
        target_description=target_description,
        limit=payload.limit,
        extra_vars=extra_vars,
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    celery = get_celery_client()
    celery.send_task(
        "worker.tasks.run_playbook",
        args=[str(job.id), [str(h.id) for h in hosts], payload.playbook, payload.limit, extra_vars],
    )

    # Built by hand (not returning `job` directly): `events` is a lazy
    # relationship, and both reading AND assigning it here trigger an
    # implicit lazy-load, which asyncpg cannot perform outside an awaited
    # call. A brand-new job has no events yet, so this is exact, not a
    # workaround.
    return AnsibleJobRead(
        id=job.id,
        user=job.user,
        playbook=job.playbook,
        target_description=job.target_description,
        limit=job.limit,
        extra_vars=job.extra_vars,
        status=job.status,
        started_at=job.started_at,
        finished_at=job.finished_at,
        changed_hosts=job.changed_hosts,
        successful_hosts=job.successful_hosts,
        failed_hosts=job.failed_hosts,
        unreachable_hosts=job.unreachable_hosts,
        created_at=job.created_at,
        events=[],
    )
