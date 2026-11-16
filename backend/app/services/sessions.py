"""Browser sessions: rotating refresh tokens in an HttpOnly cookie.

* Login creates a user_sessions row and sets the refresh cookie. The access
  token (15 min, in browser memory only) names the session in `sid`.
* /auth/refresh rotates the refresh token on every use. The previous token
  is still accepted for ROTATION_GRACE (parallel tabs racing), after that its
  reuse revokes the session: someone else holds a copy.
* Idle expiry slides with use; the absolute expiry never moves.
* The cookie is scoped to /api/auth, SameSite=Strict, HttpOnly and (by
  default) Secure. Refresh and logout also require the X-Requested-With
  header and a same-origin Origin, so a cross-site form cannot drive them.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.user import User, UserSession

COOKIE_NAME = "ops_refresh"
COOKIE_PATH = "/api/auth"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "ops-center"
ROTATION_GRACE = timedelta(seconds=30)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _limits(remember: bool) -> tuple[timedelta, timedelta]:
    s = get_settings()
    if remember:
        return timedelta(days=s.session_remember_idle_days), timedelta(days=s.session_remember_absolute_days)
    return timedelta(hours=s.session_idle_hours), timedelta(hours=s.session_absolute_hours)


def check_same_origin(request: Request) -> None:
    """CSRF guard for the cookie-authenticated endpoints."""
    if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(403, "missing request header")
    origin = request.headers.get("origin")
    if origin:
        hosts = {request.headers.get("host"), *(request.headers.get("x-forwarded-host") or "").split(",")}
        if origin.split("://", 1)[-1].rstrip("/") not in {h.strip() for h in hosts if h}:
            raise HTTPException(403, "cross-origin request refused")


def set_cookie(response: Response, token: str, session: UserSession) -> None:
    kwargs = {}
    if session.remember:
        # A persistent cookie, renewed with each rotation; the server-side idle and absolute limits still apply.
        kwargs["max_age"] = int((min(session.idle_expires_at, session.absolute_expires_at) - _now()).total_seconds())
    response.set_cookie(COOKIE_NAME, token, path=COOKIE_PATH, httponly=True, samesite="strict",
                        secure=get_settings().session_cookie_secure, **kwargs)


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH, httponly=True, samesite="strict",
                           secure=get_settings().session_cookie_secure)


def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


async def create_session(db: AsyncSession, user: User, remember: bool, request: Request) -> tuple[UserSession, str]:
    token = secrets.token_urlsafe(32)
    now = _now()
    idle, absolute = _limits(remember)
    session = UserSession(user_id=user.id, token_hash=token_hash(token), remember=remember, created_at=now,
                          last_used_at=now, idle_expires_at=now + idle, absolute_expires_at=now + absolute,
                          auth_time=now, user_agent=(request.headers.get("user-agent") or "")[:300] or None,
                          ip=request.client.host if request.client else None)
    db.add(session)
    await db.flush()
    return session, token


def is_live(session: UserSession | None, now: datetime | None = None) -> bool:
    now = now or _now()
    return (session is not None and session.revoked_at is None
            and session.idle_expires_at > now and session.absolute_expires_at > now)


async def rotate(db: AsyncSession, token: str) -> tuple[UserSession, str | None]:
    """Return the session and its new refresh token.

    The new token is None when a parallel request already rotated it within
    the grace window: that caller keeps the cookie the browser already got.
    """
    digest = token_hash(token)
    now = _now()
    session = (await db.execute(select(UserSession).where(UserSession.token_hash == digest).with_for_update())).scalar_one_or_none()
    if session is None:
        previous = (await db.execute(select(UserSession).where(UserSession.previous_token_hash == digest)
                                     .with_for_update())).scalar_one_or_none()
        if previous is None:
            raise HTTPException(401, "session not found")
        if is_live(previous, now) and previous.rotated_at and now - previous.rotated_at <= ROTATION_GRACE:
            return previous, None
        if previous.revoked_at is None:
            previous.revoked_at, previous.revoked_reason = now, "refresh_token_reuse"
            await db.commit()
        raise HTTPException(401, "session revoked")
    if not is_live(session, now):
        raise HTTPException(401, "session expired")
    new = secrets.token_urlsafe(32)
    idle, _ = _limits(session.remember)
    session.previous_token_hash, session.token_hash = session.token_hash, token_hash(new)
    session.rotated_at = session.last_used_at = now
    session.idle_expires_at = min(now + idle, session.absolute_expires_at)
    return session, new


async def revoke(db: AsyncSession, *, reason: str, by: str | None, session_id=None, user_id=None) -> int:
    query = update(UserSession).where(UserSession.revoked_at.is_(None))
    if session_id is not None:
        query = query.where(UserSession.id == session_id)
    if user_id is not None:
        query = query.where(UserSession.user_id == user_id)
    result = await db.execute(query.values(revoked_at=_now(), revoked_reason=reason, revoked_by=by))
    return result.rowcount or 0
