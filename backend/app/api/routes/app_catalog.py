from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.db.session import get_db
from app.models.app_catalog import SINGLETON_ID, AppCatalogSettings
from app.schemas.app_catalog import (
    AppCatalogSettingsRead,
    AppCatalogSettingsUpdate,
    AppTemplateRead,
    RenderTemplateRequest,
    RenderTemplateResponse,
)
from app.services import app_templates

router = APIRouter()


async def _get_settings(db: AsyncSession) -> AppCatalogSettings:
    settings = await db.get(AppCatalogSettings, SINGLETON_ID)
    if settings is None:
        # Only reachable if the migration's seed row was somehow removed -
        # recreate it with the built-in default rather than 500ing forever.
        settings = AppCatalogSettings(id=SINGLETON_ID)
        db.add(settings)
        await db.commit()
        await db.refresh(settings)
    return settings


@router.get("/app-catalog/settings", response_model=AppCatalogSettingsRead)
async def get_app_catalog_settings(db: AsyncSession = Depends(get_db)) -> AppCatalogSettings:
    return await _get_settings(db)


@router.put(
    "/app-catalog/settings",
    response_model=AppCatalogSettingsRead,
    dependencies=[Depends(require_role("admin"))],
)
async def update_app_catalog_settings(
    payload: AppCatalogSettingsUpdate, db: AsyncSession = Depends(get_db)
) -> AppCatalogSettings:
    settings = await _get_settings(db)
    settings.template_url = payload.template_url
    await db.commit()
    await db.refresh(settings)
    return settings


@router.get("/app-catalog/templates", response_model=list[AppTemplateRead])
async def list_app_templates(db: AsyncSession = Depends(get_db)) -> list[dict]:
    settings = await _get_settings(db)
    try:
        templates = await app_templates.fetch_templates(settings.template_url)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch template list: {exc}") from exc
    return [{**t, "id": i} for i, t in enumerate(templates)]


@router.post("/app-catalog/templates/{template_id}/render", response_model=RenderTemplateResponse)
async def render_app_template(
    template_id: int, payload: RenderTemplateRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    settings = await _get_settings(db)
    try:
        # Same cache fetch_templates itself uses (by URL, TTL) - rendering
        # against the exact list GET /templates just served, no drift
        # possible within the cache window. The list route above is what
        # actually assigns `id` (a plain ordinal), so it's only meaningful
        # against that same cached fetch.
        templates = await app_templates.fetch_templates(settings.template_url)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not fetch template list: {exc}") from exc

    if not (0 <= template_id < len(templates)):
        raise HTTPException(status_code=404, detail="template not found (the catalog may have refreshed - reload it)")

    try:
        compose_yaml, suggested_name = await app_templates.render_template(templates[template_id], payload.env)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"could not render template: {exc}") from exc

    return {"compose_yaml": compose_yaml, "suggested_name": suggested_name}
