import time
import uuid

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.config import get_settings
from app.models.user import User, UserSession
from app.services.auth import decode_access_token, role_at_least
from app.services.sessions import is_live

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    principal = request.scope.get("ops_mcp_principal")
    if principal is not None:
        from app.mcp.broker import INTERNAL_PRINCIPAL
        if isinstance(principal, tuple) and principal[0] is INTERNAL_PRINCIPAL:
            user = await db.get(User, principal[1])
            if user is None or not user.is_active:
                raise HTTPException(401, "MCP user is inactive")
            request.state.current_user = user
            return user
    if credentials is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    found = await user_for_token(db, credentials.credentials)
    if found is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    user, payload = found
    request.state.current_user = user
    request.state.token_payload = payload
    return user


async def user_for_token(db: AsyncSession, token: str) -> tuple[User, dict] | None:
    """Validate a bearer token: signature, expiry, a live session and an active user.

    Browser tokens name their session; a revoked or expired session ends
    them at once. Tokens without a session must be marked local (minted by
    an administration script with the API secret).
    """
    payload = decode_access_token(token)
    if payload is None:
        return None
    sid = payload.get("sid")
    if sid:
        try:
            session = await db.get(UserSession, uuid.UUID(str(sid)))
        except ValueError:
            return None
        if not is_live(session) or str(session.user_id) != str(payload.get("sub")):
            return None
    elif payload.get("local") is not True:
        return None
    user = await db.get(User, payload["sub"])
    if user is None or not user.is_active:
        return None
    return user, payload


def require_recent_auth(role: str = "admin"):
    """The role, plus a password confirmed within reauth_max_age_seconds in this session.

    Agent and MCP principals never have one, so they can never pass.
    """
    async def _check(request: Request, user: User = Depends(require_role(role))) -> User:
        payload = getattr(request.state, "token_payload", None) or {}
        auth_time = payload.get("auth_time")
        if not payload.get("sid") or not isinstance(auth_time, int) or \
                time.time() - auth_time > get_settings().reauth_max_age_seconds:
            raise HTTPException(status_code=403, detail="reauthentication required",
                                headers={"X-Reauth-Required": "1"})
        return user
    return _check


def require_role(minimum: str):
    async def _check(user: User = Depends(get_current_user)) -> User:
        if not role_at_least(user.role, minimum):
            raise HTTPException(status_code=403, detail=f"requires {minimum} role or higher")
        return user

    return _check


async def _select_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()
