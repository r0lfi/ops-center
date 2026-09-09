import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.db.session import async_session_factory, get_db
from app.models.host import (
    CRITICALITIES,
    ENVIRONMENTS,
    REBOOT_POLICIES,
    SECURITY_PATCH_POLICIES,
    Credential,
    Host,
    HostGroup,
    HostTag,
)
from app.models.monitoring import MonitoringCheck
from app.schemas.host import HostCreate, HostRead, HostUpdate
from app.services.onboarding import run_onboarding
from app.services.prometheus_sd import write_node_exporter_targets

router = APIRouter()

_LOAD_OPTS = (
    selectinload(Host.tags),
    selectinload(Host.onboarding_steps),
    selectinload(Host.credential),
    selectinload(Host.groups),
)


async def _resync_prometheus_sd(db: AsyncSession) -> None:
    result = await db.execute(select(Host))
    write_node_exporter_targets(list(result.scalars().all()))


async def _get_host_or_404(db: AsyncSession, host_id: uuid.UUID) -> Host:
    result = await db.execute(select(Host).where(Host.id == host_id).options(*_LOAD_OPTS))
    host = result.scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")
    return host


async def _apply_groups(db: AsyncSession, host: Host, group_ids: list[uuid.UUID]) -> None:
    """Sets host.groups to exactly the given groups (not additive) - matches
    how _apply_tags below replaces the whole tag set on every call."""
    if not group_ids:
        host.groups = []
        return
    result = await db.execute(select(HostGroup).where(HostGroup.id.in_(group_ids)))
    groups = list(result.scalars().all())
    missing = sorted(str(gid) for gid in group_ids if gid not in {g.id for g in groups})
    if missing:
        raise HTTPException(status_code=422, detail=f"group_ids references unknown group(s): {missing}")
    host.groups = groups


async def _apply_tags(db: AsyncSession, host: Host, tags: list[str]) -> None:
    # Issued as an explicit statement (not `for tag in host.tags: ...`) because
    # accessing an unloaded relationship triggers an implicit lazy-load, which
    # asyncpg's async driver cannot perform outside an explicit awaited call.
    await db.execute(delete(HostTag).where(HostTag.host_id == host.id))
    await db.flush()
    for tag in {t.strip() for t in tags if t.strip()}:
        db.add(HostTag(host_id=host.id, tag=tag))


async def _run_onboarding_in_background(host_id: uuid.UUID) -> None:
    # Runs after the request that created this task has already returned its
    # own session/connection, so it gets a fresh session of its own.
    async with async_session_factory() as db:
        result = await db.execute(
            select(Host).where(Host.id == host_id).options(selectinload(Host.credential))
        )
        host = result.scalar_one_or_none()
        if host is not None:
            await run_onboarding(db, host)


@router.get("/hosts", response_model=list[HostRead])
async def list_hosts(
    group_id: uuid.UUID | None = None,
    environment: str | None = None,
    criticality: str | None = None,
    tag: str | None = None,
    is_docker_host: bool | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[HostRead]:
    query = select(Host).options(*_LOAD_OPTS).order_by(Host.hostname)
    if group_id is not None:
        query = query.join(Host.groups).where(HostGroup.id == group_id)
    if environment is not None:
        query = query.where(Host.environment == environment)
    if criticality is not None:
        query = query.where(Host.criticality == criticality)
    if tag is not None:
        query = query.join(Host.tags).where(HostTag.tag == tag)
    if is_docker_host is not None:
        query = query.where(Host.is_docker_host == is_docker_host)

    result = await db.execute(query)
    hosts = result.scalars().unique().all()
    return [HostRead.from_orm_host(h) for h in hosts]


@router.post("/hosts", response_model=HostRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def create_host(
    payload: HostCreate, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)
) -> HostRead:
    try:
        payload.validate_choices()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if payload.credential_id is not None:
        credential = await db.get(Credential, payload.credential_id)
        if credential is None:
            raise HTTPException(
                status_code=422, detail="credential_id does not reference an existing credential"
            )

    host = Host(
        hostname=payload.hostname,
        fqdn=payload.fqdn,
        ip_address=payload.ip_address,
        monitoring_ip_address=payload.monitoring_ip_address,
        ssh_port=payload.ssh_port,
        ssh_user=payload.ssh_user,
        credential_id=payload.credential_id,
        environment=payload.environment,
        location=payload.location,
        criticality=payload.criticality,
        description=payload.description,
        auto_patch=payload.auto_patch,
        security_patch_policy=payload.security_patch_policy,
        reboot_policy=payload.reboot_policy,
        patch_window=payload.patch_window,
        monitoring_enabled=payload.monitoring_enabled,
        log_collection_enabled=payload.log_collection_enabled,
        is_docker_host=payload.is_docker_host,
    )
    db.add(host)
    await db.flush()
    await _apply_tags(db, host, payload.tags)
    await _apply_groups(db, host, payload.group_ids)
    for unit in {u.strip() for u in payload.services_to_monitor if u.strip()}:
        db.add(MonitoringCheck(host_id=host.id, check_type="systemd_unit", target=unit))
    await db.commit()
    await _resync_prometheus_sd(db)

    host = await _get_host_or_404(db, host.id)
    background_tasks.add_task(_run_onboarding_in_background, host.id)
    return HostRead.from_orm_host(host)


@router.get("/hosts/{host_id}", response_model=HostRead)
async def get_host(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> HostRead:
    host = await _get_host_or_404(db, host_id)
    return HostRead.from_orm_host(host)


@router.patch("/hosts/{host_id}", response_model=HostRead, dependencies=[Depends(require_role("admin"))])
async def update_host(
    host_id: uuid.UUID, payload: HostUpdate, db: AsyncSession = Depends(get_db)
) -> HostRead:
    host = await _get_host_or_404(db, host_id)

    updates = payload.model_dump(exclude_unset=True, exclude={"tags", "group_ids"})

    if "environment" in updates and updates["environment"] not in ENVIRONMENTS:
        raise HTTPException(status_code=422, detail=f"environment must be one of {ENVIRONMENTS}")
    if "criticality" in updates and updates["criticality"] not in CRITICALITIES:
        raise HTTPException(status_code=422, detail=f"criticality must be one of {CRITICALITIES}")
    if "security_patch_policy" in updates and updates["security_patch_policy"] not in SECURITY_PATCH_POLICIES:
        raise HTTPException(
            status_code=422, detail=f"security_patch_policy must be one of {SECURITY_PATCH_POLICIES}"
        )
    if "reboot_policy" in updates and updates["reboot_policy"] not in REBOOT_POLICIES:
        raise HTTPException(status_code=422, detail=f"reboot_policy must be one of {REBOOT_POLICIES}")

    if "credential_id" in updates and updates["credential_id"] is not None:
        if await db.get(Credential, updates["credential_id"]) is None:
            raise HTTPException(
                status_code=422, detail="credential_id does not reference an existing credential"
            )

    for field, value in updates.items():
        setattr(host, field, value)

    if payload.tags is not None:
        await _apply_tags(db, host, payload.tags)
    if payload.group_ids is not None:
        await _apply_groups(db, host, payload.group_ids)

    await db.commit()
    await _resync_prometheus_sd(db)
    host = await _get_host_or_404(db, host_id)
    return HostRead.from_orm_host(host)


@router.delete("/hosts/{host_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def delete_host(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    host = await _get_host_or_404(db, host_id)
    await db.delete(host)
    await db.commit()
    await _resync_prometheus_sd(db)


@router.post("/hosts/{host_id}/verify", response_model=HostRead, dependencies=[Depends(require_role("operator"))])
async def verify_host(
    host_id: uuid.UUID, background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)
) -> HostRead:
    """Retry button: re-runs the connectivity/onboarding checks for a host."""
    host = await _get_host_or_404(db, host_id)
    background_tasks.add_task(_run_onboarding_in_background, host.id)
    return HostRead.from_orm_host(host)
