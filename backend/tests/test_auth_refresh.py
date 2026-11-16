"""Refresh-cookie endpoints and bearer validation without a database.

The full session lifecycle on PostgreSQL is in test_sessions_pg.py.
"""
import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest
from fastapi import FastAPI

from app.api.deps import user_for_token
from app.api.routes.auth import router
from app.core.config import get_settings
from app.db.session import get_db
from app.models.user import User, UserSession
from app.services.auth import create_access_token

USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
SID = uuid.UUID("00000000-0000-0000-0000-0000000000aa")


def _app():
    async def database():
        yield object()

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = database
    return app


def post(path, headers=None, cookies=None):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://test",
                                     cookies=cookies or {}) as client:
            return await client.post(path, headers=headers or {})
    return asyncio.run(run())


def test_refresh_requires_csrf_header():
    assert post("/api/auth/refresh", cookies={"ops_refresh": "x"}).status_code == 403


def test_refresh_refuses_cross_origin():
    response = post("/api/auth/refresh", headers={"X-Requested-With": "ops-center", "Origin": "https://evil.example"},
                    cookies={"ops_refresh": "x"})
    assert response.status_code == 403


def test_refresh_without_cookie_is_401():
    response = post("/api/auth/refresh", headers={"X-Requested-With": "ops-center", "Origin": "http://test"})
    assert response.status_code == 401


def test_logout_requires_csrf_header():
    assert post("/api/auth/logout").status_code == 403


class FakeDB:
    def __init__(self, user, session):
        self.user, self.session = user, session

    async def get(self, model, key):
        if model is User:
            return self.user if str(key) == str(USER_ID) else None
        if model is UserSession:
            return self.session if str(key) == str(SID) else None
        raise AssertionError(model)


def _session(**changes):
    now = datetime.now(timezone.utc)
    values = dict(id=SID, user_id=USER_ID, token_hash="h", remember=True, idle_expires_at=now + timedelta(days=1),
                  absolute_expires_at=now + timedelta(days=2), auth_time=now, revoked_at=None)
    values.update(changes)
    return UserSession(**values)


def check(token, *, session=None, active=True):
    user = User(id=USER_ID, username="fixture", role="viewer", is_active=active)
    return asyncio.run(user_for_token(FakeDB(user, session), token))


def test_session_token_needs_live_session():
    token = create_access_token(str(USER_ID), "fixture", "viewer", sid=str(SID))
    assert check(token, session=_session()) is not None
    assert check(token, session=None) is None
    assert check(token, session=_session(revoked_at=datetime.now(timezone.utc))) is None
    assert check(token, session=_session(idle_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))) is None
    assert check(token, session=_session(user_id=uuid.uuid4())) is None
    assert check(token, session=_session(), active=False) is None


def test_local_script_token_is_accepted_but_legacy_token_is_not():
    assert check(create_access_token(str(USER_ID), "fixture", "viewer")) is not None
    legacy = jwt.encode({"sub": str(USER_ID), "role": "admin", "exp": int(time.time()) + 600},
                        get_settings().api_secret_key, algorithm="HS256")
    assert check(legacy) is None


@pytest.mark.parametrize("token", ["garbage", jwt.encode(
    {"sub": str(USER_ID), "local": True, "exp": 1}, "test-secret-key-not-for-production", algorithm="HS256")])
def test_invalid_or_expired_tokens_are_refused(token):
    assert check(token) is None


def test_access_token_is_short_lived_and_names_its_session():
    token = create_access_token(str(USER_ID), "fixture", "viewer", sid=str(SID))
    payload = jwt.decode(token, get_settings().api_secret_key, algorithms=["HS256"])
    assert payload["sid"] == str(SID) and "local" not in payload
    assert payload["exp"] - time.time() <= get_settings().access_token_expire_minutes * 60 + 5
