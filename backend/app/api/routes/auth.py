import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import _select_user_by_username, get_current_user, require_recent_auth, require_role
from app.db.session import get_db
from app.models.user import ROLES, User, UserSession
from app.schemas.user import LoginRequest, ReauthRequest, SessionRead, TokenResponse, UserCreate, UserRead, UserUpdate
from app.services import sessions
from app.services.auth import create_access_token, hash_password, verify_password

router = APIRouter()


def _token(user: User, session: UserSession) -> TokenResponse:
    return TokenResponse(access_token=create_access_token(str(user.id), user.username, user.role, sid=str(session.id),
                                                          auth_time=session.auth_time),
                         role=user.role, username=user.username, remember=session.remember)


@router.post("/auth/login", response_model=TokenResponse)
async def login(payload: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    user = await _select_user_by_username(db, payload.username)
    # Constant-shape response whether the username exists or not, to avoid
    # leaking which usernames are valid.
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid username or password")

    user.last_login_at = datetime.now(timezone.utc)
    session, refresh_token = await sessions.create_session(db, user, payload.remember_me, request)
    await db.commit()
    sessions.no_store(response)
    sessions.set_cookie(response, refresh_token, session)
    return _token(user, session)


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    """Issue a new access token from the refresh cookie, rotating the cookie."""
    sessions.no_store(response)
    sessions.check_same_origin(request)
    cookie = request.cookies.get(sessions.COOKIE_NAME)
    if not cookie:
        raise HTTPException(status_code=401, detail="not signed in")
    try:
        session, new_cookie = await sessions.rotate(db, cookie)
    except HTTPException:
        sessions.clear_cookie(response)
        raise
    user = await db.get(User, session.user_id)
    if user is None or not user.is_active:
        await sessions.revoke(db, reason="user_inactive", by=None, session_id=session.id)
        await db.commit()
        raise HTTPException(status_code=401, detail="user not found or inactive")
    await db.commit()
    if new_cookie:
        sessions.set_cookie(response, new_cookie, session)
    return _token(user, session)


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> Response:
    """End this browser's session at once, with or without a valid access token."""
    sessions.check_same_origin(request)
    cookie = request.cookies.get(sessions.COOKIE_NAME)
    if cookie:
        digest = sessions.token_hash(cookie)
        row = (await db.execute(select(UserSession).where(
            (UserSession.token_hash == digest) | (UserSession.previous_token_hash == digest)))).scalar_one_or_none()
        if row is not None:
            await sessions.revoke(db, reason="logout", by=None, session_id=row.id)
            await db.commit()
    result = Response(status_code=204)
    sessions.no_store(result)
    sessions.clear_cookie(result)
    return result


@router.post("/auth/reauth", response_model=TokenResponse)
async def reauth(payload: ReauthRequest, request: Request, response: Response, user: User = Depends(get_current_user),
                 db: AsyncSession = Depends(get_db)) -> TokenResponse:
    """Confirm the password again before approvals and session administration."""
    sessions.no_store(response)
    sid = (getattr(request.state, "token_payload", None) or {}).get("sid")
    if not sid:
        raise HTTPException(status_code=403, detail="reauthentication needs a browser session")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=403, detail="password incorrect")
    session = await db.get(UserSession, uuid.UUID(sid))
    if not sessions.is_live(session):
        raise HTTPException(status_code=401, detail="session expired")
    session.auth_time = datetime.now(timezone.utc)
    await db.commit()
    return _token(user, session)


def _session_read(row: UserSession, username: str, current_sid: str | None) -> SessionRead:
    return SessionRead(id=row.id, user_id=row.user_id, username=username, remember=row.remember, created_at=row.created_at,
                       last_used_at=row.last_used_at, idle_expires_at=row.idle_expires_at,
                       absolute_expires_at=row.absolute_expires_at, user_agent=row.user_agent, ip=row.ip,
                       current=str(row.id) == current_sid)


@router.get("/auth/sessions", response_model=list[SessionRead])
async def list_sessions(request: Request, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db),
                        all_users: bool = False) -> list[SessionRead]:
    """Live sessions: your own, or every user's for an administrator (all_users=true)."""
    now = datetime.now(timezone.utc)
    query = (select(UserSession, User.username).join(User, User.id == UserSession.user_id)
             .where(UserSession.revoked_at.is_(None), UserSession.idle_expires_at > now, UserSession.absolute_expires_at > now)
             .order_by(UserSession.last_used_at.desc()).limit(500))
    if not (all_users and user.role == "admin"):
        query = query.where(UserSession.user_id == user.id)
    current = (getattr(request.state, "token_payload", None) or {}).get("sid")
    return [_session_read(row, name, current) for row, name in (await db.execute(query)).all()]


@router.delete("/auth/sessions/{session_id}", status_code=204)
async def revoke_session(session_id: uuid.UUID, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> None:
    """Sign out one of your own sessions. Other users' sessions need the admin route below."""
    row = await db.get(UserSession, session_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="session not found")
    await sessions.revoke(db, reason="user_revoked", by=user.username, session_id=session_id)
    await db.commit()


@router.post("/users/{user_id}/sessions/{session_id}/revoke", status_code=204)
async def admin_revoke_session(user_id: uuid.UUID, session_id: uuid.UUID, admin: User = Depends(require_recent_auth("admin")),
                               db: AsyncSession = Depends(get_db)) -> None:
    row = await db.get(UserSession, session_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="session not found")
    await sessions.revoke(db, reason="admin_revoked", by=admin.username, session_id=session_id)
    await db.commit()


@router.post("/users/{user_id}/sessions/revoke-all")
async def admin_revoke_all(user_id: uuid.UUID, admin: User = Depends(require_recent_auth("admin")),
                           db: AsyncSession = Depends(get_db)) -> dict:
    count = await sessions.revoke(db, reason="admin_revoked", by=admin.username, user_id=user_id)
    await db.commit()
    return {"revoked": count}


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
async def update_user(user_id: uuid.UUID, payload: UserUpdate, db: AsyncSession = Depends(get_db),
                      admin: User = Depends(require_role("admin"))) -> User:
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
    # A deactivated account or a reset password ends every open session.
    if payload.is_active is False or payload.password is not None:
        await sessions.revoke(db, reason="password_changed" if payload.password is not None else "user_deactivated",
                              by=admin.username, user_id=user.id)
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
