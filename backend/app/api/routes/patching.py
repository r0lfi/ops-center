import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import Host
from app.models.job import AnsibleJob
from app.models.patch import Patch, PatchScan
from app.schemas.job import AnsibleJobRead
from app.schemas.patch import PatchRead, PatchScanRead
from app.services.celery_client import get_celery_client

from app.services.patch_reports import PATCH_PLAYBOOKS, host_results

router = APIRouter()


async def _submit_patch_job(db: AsyncSession, host_id: uuid.UUID, playbook: str) -> AnsibleJob:
    host = await db.get(Host, host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")

    job = AnsibleJob(
        playbook=playbook,
        target_description=f"host:{host_id} ({host.hostname})",
        extra_vars={},
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook", args=[str(job.id), [str(host_id)], playbook, None, {}]
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


@router.post("/hosts/{host_id}/patch-check", response_model=AnsibleJobRead, status_code=201, dependencies=[Depends(require_role("operator"))])
async def patch_check(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJobRead:
    """Read-only scan. Never modifies the host."""
    return await _submit_patch_job(db, host_id, "patch-check.yml")


@router.post("/hosts/{host_id}/patch-security", response_model=AnsibleJobRead, status_code=201, dependencies=[Depends(require_role("operator"))])
async def patch_security(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJobRead:
    """Installs security updates only. The frontend must have already
    obtained operator confirmation before calling this - it modifies the host."""
    return await _submit_patch_job(db, host_id, "patch-security.yml")


@router.post("/hosts/{host_id}/patch-all", response_model=AnsibleJobRead, status_code=201, dependencies=[Depends(require_role("operator"))])
async def patch_all(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJobRead:
    """Installs all pending updates. The frontend must have already
    obtained operator confirmation before calling this - it modifies the host."""
    return await _submit_patch_job(db, host_id, "patch-all.yml")


@router.get("/hosts/{host_id}/patches", response_model=PatchScanRead | None)
async def get_host_patches(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Latest patch scan (with its patches) for a single host."""
    result = await db.execute(
        select(PatchScan)
        .where(PatchScan.host_id == host_id)
        .options(selectinload(PatchScan.patches))
        .order_by(PatchScan.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


@router.get("/patches", response_model=list[PatchRead])
async def list_patches(
    severity: str | None = None,
    security_only: bool = False,
    db: AsyncSession = Depends(get_db),
) -> list[Patch]:
    """
    Pending patches from each host's most recent scan (not scan history) -
    what the Patching page's operator-facing table needs.
    """
    latest_scan_ids = (
        select(PatchScan.host_id, PatchScan.id.label("scan_id"), PatchScan.created_at)
        .order_by(PatchScan.host_id, PatchScan.created_at.desc())
        .distinct(PatchScan.host_id)
    ).subquery()

    query = select(Patch).where(Patch.patch_scan_id.in_(select(latest_scan_ids.c.scan_id)))
    if severity is not None:
        query = query.where(Patch.severity == severity)
    if security_only:
        query = query.where(Patch.is_security.is_(True))

    result = await db.execute(query.order_by(Patch.package_name))
    return list(result.scalars().all())


@router.get("/patching/reports")
async def patch_reports(
    status: Literal["queued", "running", "successful", "failed", "cancelled"] | None = None,
    group: str | None = Query(default=None, max_length=200),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    # Filter in SQL before pagination: monitoring jobs must not crowd out patch history.
    conditions = [AnsibleJob.playbook.in_(PATCH_PLAYBOOKS)]
    if status:
        conditions.append(AnsibleJob.status == status)
    if group:
        conditions.append(AnsibleJob.target_description.startswith(f"group:{group} (", autoescape=True))
    total = await db.scalar(select(func.count()).select_from(AnsibleJob).where(*conditions))
    result = await db.execute(
        select(AnsibleJob).where(*conditions)
        .order_by(AnsibleJob.created_at.desc(), AnsibleJob.id.desc())
        .offset(offset).limit(limit)
    )
    fields = ("id", "playbook", "target_description", "status", "created_at", "started_at", "finished_at", "successful_hosts", "changed_hosts", "failed_hosts", "unreachable_hosts")
    return {"total": total, "items": [{key: getattr(job, key) for key in fields} for job in result.scalars()]}


@router.get("/patching/reports/{job_id}")
async def patch_report(job_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(AnsibleJob).where(AnsibleJob.id == job_id, AnsibleJob.playbook.in_(PATCH_PLAYBOOKS))
        .options(selectinload(AnsibleJob.events))
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="patch report not found")
    return {"job": AnsibleJobRead.model_validate(job), "hosts": host_results(job)}
