import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt
import pytest
from fastapi import FastAPI

from app.api.routes.auth import router
from app.core.config import get_settings
from app.db.session import get_db
from app.models.user import User
from app.services.auth import create_access_token, decode_access_token

USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")


def request_refresh(token=None, *, active=True, exists=True):
    user = User(id=USER_ID, username="fixture", role="viewer", is_active=active)

    class Database:
        async def get(self, model, user_id):
            assert str(user_id) == str(USER_ID)
            return user if exists else None

    async def database():
        yield Database()

    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = database

    async def request():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.post("/api/auth/refresh", headers={"Authorization": f"Bearer {token}"} if token else {})

    return asyncio.run(request())


def test_refresh_extends_valid_session_and_uses_current_database_role():
    old = jwt.encode({"sub": str(USER_ID), "role": "admin", "exp": datetime.now(timezone.utc) + timedelta(seconds=30)},
                     get_settings().api_secret_key, algorithm="HS256")
    response = request_refresh(old)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = decode_access_token(response.json()["access_token"])
    assert payload["sub"] == str(USER_ID)
    assert payload["role"] == "viewer"
    assert payload["exp"] > datetime.now(timezone.utc).timestamp() + 3000


@pytest.mark.parametrize("token", [None, "garbage", jwt.encode(
    {"sub": str(USER_ID), "exp": 1}, "test-secret-key-not-for-production", algorithm="HS256"
)])
def test_refresh_rejects_missing_invalid_or_expired_tokens(token):
    assert request_refresh(token).status_code == 401


@pytest.mark.parametrize("active,exists", [(False, True), (True, False)])
def test_refresh_rejects_disabled_or_deleted_user(active, exists):
    token = create_access_token(str(USER_ID), "fixture", "viewer")
    assert request_refresh(token, active=active, exists=exists).status_code == 401
