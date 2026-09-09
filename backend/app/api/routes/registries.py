import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import get_db
from app.models.container import Registry
from app.schemas.registry import RegistryCreate, RegistryRead

router = APIRouter()


@router.get("/registries", response_model=list[RegistryRead])
async def list_registries(db: AsyncSession = Depends(get_db)) -> list[Registry]:
    result = await db.execute(select(Registry).order_by(Registry.name))
    return list(result.scalars().all())


@router.post("/registries", response_model=RegistryRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def create_registry(payload: RegistryCreate, db: AsyncSession = Depends(get_db)) -> Registry:
    secret_path = None
    if payload.secret_filename:
        settings = get_settings()
        secrets_root = Path(settings.secrets_root).resolve()
        secret_file = (secrets_root / "registries" / payload.secret_filename).resolve()
        if not str(secret_file).startswith(str(secrets_root / "registries") + "/"):
            raise HTTPException(status_code=422, detail="invalid secret_filename")
        if not secret_file.exists():
            raise HTTPException(
                status_code=422,
                detail=(
                    f"no file named '{payload.secret_filename}' found under "
                    f"{settings.secrets_root}/registries - place the password/token file there "
                    "first, outside of git, then reference it here"
                ),
            )
        secret_path = f"registries/{payload.secret_filename}"

    existing = await db.execute(select(Registry).where(Registry.name == payload.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="a registry with this name already exists")

    registry = Registry(
        name=payload.name,
        url=payload.url,
        username=payload.username,
        secret_path=secret_path,
        auth_required=payload.auth_required,
        description=payload.description,
    )
    db.add(registry)
    await db.commit()
    await db.refresh(registry)
    return registry


@router.delete("/registries/{registry_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def delete_registry(registry_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    registry = await db.get(Registry, registry_id)
    if registry is None:
        raise HTTPException(status_code=404, detail="registry not found")
    await db.delete(registry)
    await db.commit()
