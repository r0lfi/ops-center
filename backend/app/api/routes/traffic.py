from fastapi import APIRouter, Query, Depends, HTTPException
from app.api.deps import require_role
from app.services.traffic_store import snapshot, recent
router = APIRouter()

@router.get("/traffic/live")
async def live_traffic(since: float = Query(default=0.0,ge=0)) -> dict:
    return await recent(since)

@router.get("/traffic/history")
async def traffic_history(
    hours: int = Query(default=24,ge=1,le=720),
    service: str = Query(default="all",pattern="^[a-z][a-z0-9_-]{0,31}$"),
    errors: bool = False,
    search: str = Query(default="",max_length=100),
    limit: int = Query(default=100,ge=1,le=200),
    offset: int = Query(default=0,ge=0,le=500000),
    until: float | None = Query(default=None,ge=0),
) -> dict:
    return await snapshot(hours,service,errors,search,limit,offset,until)


@router.get("/traffic/security")
async def traffic_security(service: str = Query(default="all",pattern="^[a-z][a-z0-9_-]{0,31}$"),
                           hours: int = Query(default=24,ge=1,le=720),
                           auth_result: str = Query(default="all",pattern="^(all|failed|success|vpn)$"),
                           auth_offset: int = Query(default=0,ge=0,le=500000)) -> dict:
    from app.services.traffic_security import security_snapshot
    return await security_snapshot(service,hours,auth_result,auth_offset)

@router.post("/traffic/security/{alert_id}/review")
async def review_traffic_security(alert_id: int, user=Depends(require_role("admin"))):
    import time
    from app.db.session import async_session_factory
    from app.models.traffic import TrafficSecurityAlert
    async with async_session_factory() as db, db.begin():
        alert=await db.get(TrafficSecurityAlert,alert_id,with_for_update=True)
        if alert is None:raise HTTPException(status_code=404,detail="Security signal not found")
        if alert.reviewed_at is None:
            alert.reviewed_at=time.time()
            alert.reviewed_by=user.username
    return {"ok":True}


@router.get("/traffic/security/banner")
async def traffic_authentication_banner() -> dict:
    from app.services.traffic_security import authentication_banner
    return await authentication_banner()
