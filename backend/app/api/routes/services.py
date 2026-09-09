import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import Host
from app.models.monitoring import CHECK_TYPES, MonitoringCheck
from app.schemas.monitoring import MonitoringCheckCreate, MonitoringCheckRead

router = APIRouter()


@router.get("/services", response_model=list[MonitoringCheckRead])
async def list_services(host_id: uuid.UUID | None = None, db: AsyncSession = Depends(get_db)) -> list[MonitoringCheck]:
    query = select(MonitoringCheck)
    if host_id is not None:
        query = query.where(MonitoringCheck.host_id == host_id)
    result = await db.execute(query)
    return list(result.scalars().all())


@router.post("/hosts/{host_id}/services", response_model=MonitoringCheckRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def add_service_check(
    host_id: uuid.UUID, payload: MonitoringCheckCreate, db: AsyncSession = Depends(get_db)
) -> MonitoringCheck:
    if payload.check_type not in CHECK_TYPES:
        raise HTTPException(status_code=422, detail=f"check_type must be one of {CHECK_TYPES}")
    if await db.get(Host, host_id) is None:
        raise HTTPException(status_code=404, detail="host not found")

    check = MonitoringCheck(
        host_id=host_id, check_type=payload.check_type, target=payload.target, enabled=payload.enabled
    )
    db.add(check)
    await db.commit()
    await db.refresh(check)
    return check


@router.delete("/hosts/{host_id}/services/{check_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def remove_service_check(host_id: uuid.UUID, check_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    check = await db.get(MonitoringCheck, check_id)
    if check is None or check.host_id != host_id:
        raise HTTPException(status_code=404, detail="check not found")
    await db.delete(check)
    await db.commit()
