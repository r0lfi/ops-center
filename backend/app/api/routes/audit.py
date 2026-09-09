from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.db.session import get_db
from app.models.audit import AuditLogEntry
from app.schemas.audit import AuditLogRead

router = APIRouter()


@router.get("/audit", response_model=list[AuditLogRead], dependencies=[Depends(require_role("admin"))])
async def list_audit_log(limit: int = 200, db: AsyncSession = Depends(get_db)) -> list[AuditLogEntry]:
    result = await db.execute(select(AuditLogEntry).order_by(AuditLogEntry.created_at.desc()).limit(min(limit, 1000)))
    return list(result.scalars().all())
