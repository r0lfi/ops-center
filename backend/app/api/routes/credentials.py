import uuid
from pathlib import Path

import asyncssh
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import CREDENTIAL_TYPES, Credential
from app.schemas.host import CredentialCreate, CredentialRead

router = APIRouter()


def _fingerprint(public_key_text: str) -> str | None:
    try:
        return asyncssh.import_public_key(public_key_text).get_fingerprint()
    except asyncssh.KeyImportError:
        return None


@router.get("/credentials", response_model=list[CredentialRead])
async def list_credentials(db: AsyncSession = Depends(get_db)) -> list[Credential]:
    result = await db.execute(select(Credential).order_by(Credential.name))
    return list(result.scalars().all())


@router.post("/credentials", response_model=CredentialRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def create_credential(payload: CredentialCreate, db: AsyncSession = Depends(get_db)) -> Credential:
    if payload.credential_type not in CREDENTIAL_TYPES:
        raise HTTPException(status_code=422, detail=f"credential_type must be one of {CREDENTIAL_TYPES}")

    settings = get_settings()
    secrets_root = Path(settings.secrets_root).resolve()
    secret_file = (secrets_root / "credentials" / payload.secret_filename).resolve()
    if not str(secret_file).startswith(str(secrets_root / "credentials") + "/"):
        raise HTTPException(status_code=422, detail="invalid secret_filename")
    if not secret_file.exists():
        raise HTTPException(
            status_code=422,
            detail=(
                f"no file named '{payload.secret_filename}' found under "
                f"{settings.secrets_root}/credentials - place the key/password file there first, "
                "outside of git, then reference it here"
            ),
        )

    existing = await db.execute(select(Credential).where(Credential.name == payload.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="a credential with this name already exists")

    credential = Credential(
        name=payload.name,
        description=payload.description,
        credential_type=payload.credential_type,
        ssh_user=payload.ssh_user,
        secret_path=f"credentials/{payload.secret_filename}",
        public_key=payload.public_key,
        public_key_fingerprint=_fingerprint(payload.public_key) if payload.public_key else None,
    )
    db.add(credential)
    await db.commit()
    await db.refresh(credential)
    return credential


@router.delete("/credentials/{credential_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def delete_credential(credential_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> None:
    credential = await db.get(Credential, credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="credential not found")
    # Hosts referencing this credential fall back to credential_id=NULL
    # (ON DELETE SET NULL) rather than being blocked or cascade-deleted -
    # deleting a credential should never silently delete a server.
    await db.delete(credential)
    await db.commit()
