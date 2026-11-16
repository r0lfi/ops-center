"""Session lifecycle on real PostgreSQL (schema at head).

    SESSIONS_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_sessions_test?host=/path/to/socket' pytest
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.session import get_db
from app.main import app
from app.models.user import User, UserSession
from app.services import sessions
from app.services.auth import hash_password

URL = os.environ.get("SESSIONS_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif("/ops_sessions_test" not in URL, reason="needs SESSIONS_TEST_DATABASE_URL for ops_sessions_test")
CSRF = {"X-Requested-With": "ops-center", "Origin": "http://test"}
PASSWORD = "correct horse battery"


def scenario(body):
    async def run():
        engine = create_async_engine(URL)
        assert engine.url.database == "ops_sessions_test"
        maker = async_sessionmaker(engine, expire_on_commit=False)
        async with maker() as db:
            await db.execute(text("DELETE FROM user_sessions"))
            await db.execute(text("DELETE FROM users WHERE username LIKE 'sess-%'"))
            users = {r: User(username=f"sess-{r}", password_hash=hash_password(PASSWORD), role=r, is_active=True)
                     for r in ("admin", "viewer")}
            db.add_all(users.values())
            await db.commit()

            async def database():
                async with maker() as s:
                    yield s

            app.dependency_overrides[get_db] = database
            try:
                # The audit middleware writes with its own factory; keep it on the test database.
                with patch("app.middleware.audit.async_session_factory", maker):
                    async def client():
                        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
                    await body(client, maker, users)
            finally:
                app.dependency_overrides.clear()
        await engine.dispose()
    with patch.object(sessions.get_settings(), "session_cookie_secure", False):
        asyncio.run(run())


async def _login(c, name="sess-viewer", remember=True):
    r = await c.post("/api/auth/login", json={"username": name, "password": PASSWORD, "remember_me": remember})
    assert r.status_code == 200, r.text
    return r


def test_login_sets_httponly_strict_cookie_and_remember_lasts_30_days():
    async def body(client, maker, users):
        async with await client() as c:
            r = await _login(c)
            cookie = r.headers["set-cookie"].lower()
            assert "httponly" in cookie and "samesite=strict" in cookie and "path=/api/auth" in cookie
            max_age = int(cookie.split("max-age=")[1].split(";")[0])
            assert 29 * 86400 < max_age <= 30 * 86400
            assert r.json()["remember"] is True
            me = await c.get("/api/auth/me", headers={"Authorization": "Bearer " + r.json()["access_token"]})
            assert me.status_code == 200
        async with await client() as c:
            r = await _login(c, remember=False)
            assert "max-age" not in r.headers["set-cookie"].lower()  # ends with the browser
    scenario(body)


def test_refresh_rotates_and_reuse_after_grace_revokes_the_session():
    async def body(client, maker, users):
        async with await client() as c:
            await _login(c)
            first = c.cookies.get("ops_refresh")
            r = await c.post("/api/auth/refresh", headers=CSRF)
            assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
            second = c.cookies.get("ops_refresh")
            assert second and second != first
            # A parallel tab presenting the old cookie inside the grace window still gets an access token.
            c.cookies.set("ops_refresh", first, path="/api/auth")
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 200
            async with maker() as db:
                await db.execute(update(UserSession).values(rotated_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
                await db.commit()
            c.cookies.set("ops_refresh", first, path="/api/auth")
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 401
            c.cookies.set("ops_refresh", second, path="/api/auth")
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 401
            async with maker() as db:
                row = (await db.execute(select(UserSession))).scalar_one()
                assert row.revoked_reason == "refresh_token_reuse"
    scenario(body)


def test_logout_invalidates_access_token_and_cookie_at_once():
    async def body(client, maker, users):
        async with await client() as c:
            token = (await _login(c)).json()["access_token"]
            auth = {"Authorization": "Bearer " + token}
            assert (await c.get("/api/auth/me", headers=auth)).status_code == 200
            assert (await c.post("/api/auth/logout", headers=CSRF)).status_code == 204
            assert (await c.get("/api/auth/me", headers=auth)).status_code == 401
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 401
    scenario(body)


def test_idle_and_absolute_expiry_end_the_session():
    async def body(client, maker, users):
        async with await client() as c:
            await _login(c)
            async with maker() as db:
                await db.execute(update(UserSession).values(idle_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
                await db.commit()
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 401
        async with await client() as c:
            await _login(c)
            live = UserSession.idle_expires_at > datetime.now(timezone.utc)
            async with maker() as db:
                await db.execute(update(UserSession).where(live)
                                 .values(absolute_expires_at=datetime.now(timezone.utc) + timedelta(seconds=30)))
                await db.commit()
            assert (await c.post("/api/auth/refresh", headers=CSRF)).status_code == 200
            async with maker() as db:
                row = (await db.execute(select(UserSession).where(live))).scalar_one()
                # Activity never extends past the hard cap.
                assert row.idle_expires_at <= row.absolute_expires_at
    scenario(body)


def test_admin_revocation_needs_recent_password_and_ends_the_session():
    async def body(client, maker, users):
        async with await client() as victim, await client() as admin:
            viewer_token = (await _login(victim)).json()["access_token"]
            admin_token = (await _login(admin, "sess-admin")).json()["access_token"]
            auth = {"Authorization": "Bearer " + admin_token}
            listed = (await admin.get("/api/auth/sessions?all_users=true", headers=auth)).json()
            target = next(s for s in listed if s["username"] == "sess-viewer")
            path = f"/api/users/{target['user_id']}/sessions/{target['id']}/revoke"
            # Login counts as a fresh password check; age it past the limit.
            async with maker() as db:
                await db.execute(update(UserSession).values(auth_time=datetime.now(timezone.utc) - timedelta(hours=1)))
                await db.commit()
            stale = (await admin.post("/api/auth/refresh", headers=CSRF)).json()["access_token"]
            r = await admin.post(path, headers={"Authorization": "Bearer " + stale})
            assert r.status_code == 403 and r.headers.get("x-reauth-required") == "1"
            assert (await admin.post("/api/auth/reauth", json={"password": "wrong"},
                                     headers={"Authorization": "Bearer " + stale})).status_code == 403
            fresh = (await admin.post("/api/auth/reauth", json={"password": PASSWORD},
                                      headers={"Authorization": "Bearer " + stale})).json()["access_token"]
            assert (await admin.post(path, headers={"Authorization": "Bearer " + fresh})).status_code == 204
            assert (await victim.get("/api/auth/me", headers={"Authorization": "Bearer " + viewer_token})).status_code == 401
            # A viewer cannot use the admin route.
            assert (await victim.post(path, headers={"Authorization": "Bearer " + viewer_token})).status_code == 401
    scenario(body)


def test_deactivating_a_user_revokes_their_sessions():
    async def body(client, maker, users):
        async with await client() as victim, await client() as admin:
            viewer_token = (await _login(victim)).json()["access_token"]
            admin_token = (await _login(admin, "sess-admin")).json()["access_token"]
            r = await admin.patch(f"/api/users/{users['viewer'].id}", json={"is_active": False},
                                  headers={"Authorization": "Bearer " + admin_token})
            assert r.status_code == 200
            async with maker() as db:
                row = (await db.execute(select(UserSession).where(UserSession.user_id == users["viewer"].id))).scalar_one()
                assert row.revoked_reason == "user_deactivated"
            assert (await victim.get("/api/auth/me", headers={"Authorization": "Bearer " + viewer_token})).status_code == 401
    scenario(body)
