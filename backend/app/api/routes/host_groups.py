import uuid

import croniter
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import GROUP_PATCH_PLAYBOOKS, GROUP_PATCH_TYPES, Host, HostGroup
from app.models.job import AnsibleJob
from app.schemas.host import HostGroupRead, HostGroupUpdate
from app.schemas.job import AnsibleJobRead
from app.services.celery_client import get_celery_client

router = APIRouter()


class HostGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    # Optional auto-patch schedule. Leave cron_expression unset for an
    # ordinary (non-scheduled) group.
    cron_expression: str | None = None
    patch_type: str | None = None
    batch_size: int = Field(default=1, ge=1, le=1000)
    schedule_enabled: bool = False


def _validate_schedule(cron_expression: str | None, patch_type: str | None) -> None:
    if cron_expression is not None:
        if not croniter.croniter.is_valid(cron_expression):
            raise HTTPException(status_code=422, detail=f"invalid cron_expression: {cron_expression!r}")
        if patch_type not in GROUP_PATCH_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"patch_type must be one of {GROUP_PATCH_TYPES} when cron_expression is set",
            )
    elif patch_type is not None and patch_type not in GROUP_PATCH_TYPES:
        raise HTTPException(status_code=422, detail=f"patch_type must be one of {GROUP_PATCH_TYPES}")


async def _get_group_or_404(db: AsyncSession, group_id: uuid.UUID) -> HostGroup:
    result = await db.execute(
        select(HostGroup).where(HostGroup.id == group_id).options(selectinload(HostGroup.hosts))
    )
    group = result.scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="group not found")
    return group


@router.get("/host-groups", response_model=list[HostGroupRead])
async def list_host_groups(db: AsyncSession = Depends(get_db)) -> list[HostGroup]:
    result = await db.execute(
        select(HostGroup).options(selectinload(HostGroup.hosts)).order_by(HostGroup.name)
    )
    return list(result.scalars().all())


@router.post("/host-groups", response_model=HostGroupRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def create_host_group(payload: HostGroupCreate, db: AsyncSession = Depends(get_db)) -> HostGroup:
    _validate_schedule(payload.cron_expression, payload.patch_type)

    existing = await db.execute(select(HostGroup).where(HostGroup.name == payload.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="a group with this name already exists")

    group = HostGroup(
        name=payload.name,
        description=payload.description,
        cron_expression=payload.cron_expression,
        patch_type=payload.patch_type,
        batch_size=payload.batch_size,
        schedule_enabled=payload.schedule_enabled,
    )
    db.add(group)
    await db.commit()
    return await _get_group_or_404(db, group.id)


@router.patch("/host-groups/{group_id}", response_model=HostGroupRead, dependencies=[Depends(require_role("admin"))])
async def update_host_group(
    group_id: uuid.UUID, payload: HostGroupUpdate, db: AsyncSession = Depends(get_db)
) -> HostGroup:
    group = await _get_group_or_404(db, group_id)
    updates = payload.model_dump(exclude_unset=True)

    cron_expression = updates.get("cron_expression", group.cron_expression)
    patch_type = updates.get("patch_type", group.patch_type)
    _validate_schedule(cron_expression, patch_type)

    if "name" in updates and updates["name"] != group.name:
        existing = await db.execute(select(HostGroup).where(HostGroup.name == updates["name"]))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="a group with this name already exists")

    for field, value in updates.items():
        setattr(group, field, value)

    await db.commit()
    return await _get_group_or_404(db, group_id)


@router.delete("/host-groups/{group_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def delete_host_group(group_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    group = await db.get(HostGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="group not found")
    # Membership rows in host_group_members cascade-delete with the group -
    # deleting a group never deletes or orphans a server, it just drops that
    # one membership (a host in other groups too keeps those).
    await db.delete(group)
    await db.commit()


@router.post(
    "/host-groups/{group_id}/hosts/{host_id}",
    response_model=HostGroupRead,
    dependencies=[Depends(require_role("admin"))],
)
async def add_host_to_group(group_id: uuid.UUID, host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> HostGroup:
    group = await _get_group_or_404(db, group_id)
    result = await db.execute(select(Host).where(Host.id == host_id).options(selectinload(Host.groups)))
    host = result.scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")
    # A host can be in any number of groups at once (e.g. an OS-patching
    # group and a separate app-specific one like pihole updates, each on
    # its own schedule) - append is a no-op if it's already a member.
    if not any(g.id == group_id for g in host.groups):
        host.groups.append(group)
        await db.commit()
    return await _get_group_or_404(db, group_id)


@router.delete(
    "/host-groups/{group_id}/hosts/{host_id}",
    response_model=HostGroupRead,
    dependencies=[Depends(require_role("admin"))],
)
async def remove_host_from_group(
    group_id: uuid.UUID, host_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> HostGroup:
    await _get_group_or_404(db, group_id)
    result = await db.execute(select(Host).where(Host.id == host_id).options(selectinload(Host.groups)))
    host = result.scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")
    if any(g.id == group_id for g in host.groups):
        host.groups = [g for g in host.groups if g.id != group_id]
        await db.commit()
    return await _get_group_or_404(db, group_id)


@router.post(
    "/host-groups/{group_id}/run-now",
    response_model=AnsibleJobRead,
    status_code=201,
    dependencies=[Depends(require_role("operator"))],
)
async def run_group_now(group_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJobRead:
    """Manually trigger this group's patch run immediately, independent of
    its schedule - for testing a new schedule or an ad-hoc off-cycle run."""
    group = await _get_group_or_404(db, group_id)
    if group.patch_type not in GROUP_PATCH_TYPES:
        raise HTTPException(status_code=422, detail="group has no patch_type configured")
    if not group.hosts:
        raise HTTPException(status_code=422, detail="group has no member hosts")

    playbook = GROUP_PATCH_PLAYBOOKS[group.patch_type]
    extra_vars = {"batch_size": group.batch_size}

    job = AnsibleJob(
        playbook=playbook,
        target_description=f"group:{group.name} ({len(group.hosts)} hosts, manual run)",
        extra_vars=extra_vars,
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook",
        args=[str(job.id), [str(h.id) for h in group.hosts], playbook, None, extra_vars],
    )

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
