import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import _select_user_by_username, get_current_user, require_role
from app.db.session import get_db
from app.models.user import ROLES, User
from app.schemas.user import LoginRequest, TokenResponse, UserCreate, UserRead, UserUpdate
from app.services.auth import create_access_token, hash_password, verify_password

router = APIRouter()


@router.post("/auth/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await _select_user_by_username(db, payload.username)
    # Constant-shape response whether the username exists or not, to avoid
    # leaking which usernames are valid.
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid username or password")

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    token = create_access_token(str(user.id), user.username, user.role)
    return TokenResponse(access_token=token, role=user.role, username=user.username)


@router.get("/auth/me", response_model=UserRead)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.get("/users", response_model=list[UserRead], dependencies=[Depends(require_role("admin"))])
async def list_users(db: AsyncSession = Depends(get_db)) -> list[User]:
    result = await db.execute(select(User).order_by(User.username))
    return list(result.scalars().all())


@router.post("/users", response_model=UserRead, status_code=201, dependencies=[Depends(require_role("admin"))])
async def create_user(payload: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
    if payload.role not in ROLES:
        raise HTTPException(status_code=422, detail=f"role must be one of {ROLES}")
    if await _select_user_by_username(db, payload.username) is not None:
        raise HTTPException(status_code=409, detail="a user with this username already exists")

    user = User(username=payload.username, password_hash=hash_password(payload.password), role=payload.role)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserRead, dependencies=[Depends(require_role("admin"))])
async def update_user(user_id: uuid.UUID, payload: UserUpdate, db: AsyncSession = Depends(get_db)) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    if payload.role is not None:
        if payload.role not in ROLES:
            raise HTTPException(status_code=422, detail=f"role must be one of {ROLES}")
        user.role = payload.role
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204, dependencies=[Depends(require_role("admin"))])
async def delete_user(user_id: uuid.UUID, current: User = Depends(require_role("admin")), db: AsyncSession = Depends(get_db)) -> None:
    if user_id == current.id:
        raise HTTPException(status_code=400, detail="cannot delete your own account")
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    await db.delete(user)
    await db.commit()
