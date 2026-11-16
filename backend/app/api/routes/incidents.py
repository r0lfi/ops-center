"""Authenticated incident workflow; acknowledgement never authorizes operational changes."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func
from app.api.deps import require_role
from app.db.session import async_session_factory
from app.models.incidents import Incident, IMCondition, IMEvent, IMSettings, IMDelivery, IMInvestigation
from app.models.ai import AIAgent, AIProvider, AITask
from app.models.ai_memory import AIMemoryPreference
from app.models.user import User
from app.schemas.incidents import IMConfig, IMDecision, CATEGORIES, SEVERITIES
from app.services import incidents as service

router = APIRouter()


def view(row):
    return {
        k: getattr(row, k)
        for k in (
            "id",
            "category",
            "rule",
            "resource",
            "title",
            "severity",
            "status",
            "source_state",
            "details",
            "observations",
            "revision",
            "created_at",
            "last_seen",
            "completed_at",
            "updated_by",
            "talk_policy",
        )
    }


@router.get("/incidents")
async def list_incidents(
    status: str = "open",
    category: str = "all",
    q: str = Query("", max_length=200),
    offset: int = Query(0, ge=0),
    user=Depends(require_role("viewer")),
):
    if status not in (
        "open",
        "all",
        "new",
        "approved",
        "in_progress",
        "completed",
    ) or category not in ("all", *CATEGORIES):
        raise HTTPException(422, "Invalid filter")
    filters = []
    if status == "open":
        filters.append(Incident.status != "completed")
    elif status != "all":
        filters.append(Incident.status == status)
    if category != "all":
        filters.append(Incident.category == category)
    if q:
        term = (
            "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        filters.append(Incident.resource.ilike(term) | Incident.title.ilike(term))
    async with async_session_factory() as db:
        rows = (
            await db.scalars(
                select(Incident)
                .where(*filters)
                .order_by(Incident.id.desc())
                .offset(offset)
                .limit(50)
            )
        ).all()
        total = await db.scalar(
            select(func.count()).select_from(Incident).where(*filters)
        )
        state = await db.get(IMSettings, 1)
        return {
            "items": [view(r) for r in rows],
            "total": total,
            "offset": offset,
            "monitor": (state.value if state else {}).get("monitor", {}),
            "workflow_enabled": (state.value if state else {}).get("workflow_enabled", True),
        }


@router.get("/incidents/{ident}")
async def incident_detail(ident: int, user=Depends(require_role("viewer"))):
    async with async_session_factory() as db:
        row = await db.get(Incident, ident)
        if not row:
            raise HTTPException(404, "IM task not found")
        history = (
            await db.scalars(
                select(IMEvent).where(IMEvent.incident_id == ident).order_by(IMEvent.id)
            )
        ).all()
        deliveries = (
            await db.scalars(select(IMDelivery).where(IMDelivery.incident_id == ident))
        ).all()
        investigation = await db.get(IMInvestigation, ident)
        task = await db.get(AITask, investigation.task_id) if investigation else None
        return {
            **view(row),
            "investigation": {
                "task_id": str(task.id) if task.owner_user_id == getattr(user, "id", None) else None,
                "status": task.status,
                "agent_id": str(task.agent_id),
                "created_at": investigation.created_at,
            } if task else None,
            "history": [
                {k: getattr(e, k) for k in ("actor", "status", "note", "created_at")}
                for e in history
            ],
            "deliveries": [
                {k: getattr(d, k) for k in ("status", "claimed_at", "sent_at")}
                for d in deliveries
            ],
        }


@router.post("/incidents/{ident}/status")
async def change_status(
    ident: int,
    body: IMDecision,
    request: Request,
    user=Depends(require_role("operator")),
):
    if request.scope.get("ops_mcp_principal") is not None:
        raise HTTPException(403, "IM decisions require the human interface")
    async with async_session_factory() as db, db.begin():
        return view(await service.decide(db, ident, body, user))


@router.get("/settings/incidents")
async def get_config(user=Depends(require_role("admin"))):
    from app.core.config import get_settings

    async with async_session_factory() as db:
        config = await service.load_config(db)
        owner = await db.get(User, config.investigation_owner_user_id) if config.investigation_owner_user_id else None
        preference = await db.get(AIMemoryPreference, owner.id) if owner else None
        return {
            **config.model_dump(),
            "memory_enabled": bool(owner and owner.is_active and (preference is None or preference.enabled)),
            "transport_enabled": get_settings().talk_notifications_enabled,
        }


@router.put("/settings/incidents")
async def put_config(body: IMConfig, user=Depends(require_role("admin"))):
    async with async_session_factory() as db, db.begin():
        row = await db.get(IMSettings, 1, with_for_update=True)
        if not row:
            raise HTTPException(503, "IM migration is missing")
        if row.revision != body.revision:
            raise HTTPException(409, "Settings changed. Reload before saving.")
        if any(
            len(v) > 500 or not v.strip()
            for v in body.excluded_resources + body.excluded_rules
        ):
            raise HTTPException(
                422, "Exclusions must be nonempty and at most 500 characters"
            )
        previous = await service.load_config(db)
        # Owner comes from the authenticated administrator, never an arbitrary UUID.
        # Existing ownership may be retained while another admin changes routing.
        if body.auto_investigate:
            proposed_owner = body.investigation_owner_user_id or user.id
            if proposed_owner not in (user.id, previous.investigation_owner_user_id):
                raise HTTPException(403, "Automatic investigations must belong to the configuring administrator")
            owner = await db.get(User, proposed_owner)
            agent = await db.scalar(select(AIAgent).join(AIProvider, AIAgent.provider_id == AIProvider.id).where(
                AIAgent.slug == body.investigation_agent, AIAgent.enabled.is_(True), AIProvider.enabled.is_(True)))
            if not owner or not owner.is_active or owner.role != "admin" or not agent:
                raise HTTPException(422, "Choose an active administrator owner and an enabled agent/provider")
            enabled_at = previous.investigation_enabled_at if previous.auto_investigate else service.utcnow()
            body = body.model_copy(update={"investigation_owner_user_id": proposed_owner,
                "investigation_enabled_at": enabled_at or service.utcnow()})
        else:
            body = body.model_copy(update={"investigation_owner_user_id": previous.investigation_owner_user_id,
                "investigation_enabled_at": previous.investigation_enabled_at})
        monitor = row.value.get("monitor", {})
        row.value = {**body.model_dump(mode="json", exclude={"revision"}), "monitor": monitor}
        row.revision += 1
        from app.core.config import get_settings
        owner = await db.get(User, body.investigation_owner_user_id) if body.investigation_owner_user_id else None
        preference = await db.get(AIMemoryPreference, owner.id) if owner else None
        return {**body.model_dump(), "revision": row.revision,
            "transport_enabled": get_settings().talk_notifications_enabled,
            "memory_enabled": bool(owner and owner.is_active and (preference is None or preference.enabled))}
