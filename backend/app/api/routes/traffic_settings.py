"""Admin configuration API; credentials remain on managed Host records."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from app.api.deps import require_role
from app.db.session import async_session_factory
from app.models.host import Host
from app.models.traffic import TrafficSettings
from app.schemas.traffic_settings import TrafficSettingsConfig
from app.services.traffic_settings import load_config

router = APIRouter()


@router.get("/settings/traffic", response_model=TrafficSettingsConfig)
async def get_traffic_settings(user=Depends(require_role("admin"))):
    return await load_config()


@router.put("/settings/traffic", response_model=TrafficSettingsConfig)
async def put_traffic_settings(
    config: TrafficSettingsConfig, user=Depends(require_role("admin"))
):
    async with async_session_factory() as db, db.begin():
        row = await db.get(TrafficSettings, 1, with_for_update=True)
        if row is None:
            raise HTTPException(503, "Traffic settings migration has not been applied")
        if row.revision != config.revision:
            raise HTTPException(
                409, "Settings changed in another session. Reload before saving."
            )
        for source in config.sources:
            host = await db.get(Host, source.host_id)
            if host is None:
                raise HTTPException(
                    422, f"Source {source.id} must reference a registered server"
                )
            if (
                config.enabled
                and source.enabled
                and (not host.credential_id or not host.ssh_host_fingerprint)
            ):
                raise HTTPException(
                    422,
                    f"Complete SSH onboarding and record the host fingerprint for {host.hostname} before enabling collection",
                )
        row.value = config.model_dump(mode="json", exclude={"revision"})
        row.revision += 1
        return TrafficSettingsConfig.model_validate(
            {**row.value, "revision": row.revision}
        )
