"""Explicit disposable-PostgreSQL integration checks; all schema changes roll back.

Run with TEST_TRAFFIC_DATABASE_URL and PYTHONPATH=backend:. from the repo root.
There is deliberately no fallback to the application's DATABASE_URL.
"""

import asyncio
import importlib.util
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

# Imports construct application settings, but tests must never inherit live URLs.
if not os.environ.get("TEST_TRAFFIC_DATABASE_URL"):
    raise SystemExit("Set TEST_TRAFFIC_DATABASE_URL to a disposable PostgreSQL database")
os.environ["DATABASE_URL"] = os.environ["TEST_TRAFFIC_DATABASE_URL"]
os.environ["DATABASE_URL_SYNC"] = os.environ["TEST_TRAFFIC_DATABASE_URL"].replace("+asyncpg", "+psycopg")
os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"
os.environ["API_SECRET_KEY"] = "synthetic-database-test-only"
os.environ["TALK_NOTIFICATIONS_ENABLED"] = "false"

from app.models.traffic import (
    TrafficEntry as E,
    TrafficCollector as C,
    TrafficSecurityAlert as A,
    TrafficSettings,
)
from app.models.user import User
from app.schemas.traffic_settings import TrafficSettingsConfig, TrafficSourceConfig
from app.services import (
    traffic_auth as auth,
    traffic_settings as settings,
    traffic_security as security,
    traffic_store as store,
)


async def main():
    url = os.environ.get("TEST_TRAFFIC_DATABASE_URL")
    if not url:
        raise SystemExit(
            "Set TEST_TRAFFIC_DATABASE_URL to a disposable PostgreSQL database"
        )
    engine = create_async_engine(url)
    schema = "traffic_verify_" + uuid.uuid4().hex
    migrations = []
    for name in (
        "0038_traffic_history.py",
        "0039_traffic_security.py",
        "0041_traffic_settings.py",
    ):
        spec = importlib.util.spec_from_file_location(
            name, Path(__file__).resolve().parents[1] / "migrations/versions" / name
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        migrations.append(module)
    async with engine.connect() as connection:
        outer = await connection.begin()
        try:
            await connection.execute(text('CREATE SCHEMA "' + schema + '"'))
            # Never fall through to production/public tables, even for users.
            await connection.execute(text('SET LOCAL search_path TO "' + schema + '"'))

            def migrate(sync, action):
                with Operations.context(MigrationContext.configure(sync)):
                    action()

            for module in migrations:
                await connection.run_sync(lambda sync: migrate(sync, module.upgrade))
            await connection.run_sync(User.__table__.create)

            @asynccontextmanager
            async def sessions():
                async with AsyncSession(
                    bind=connection,
                    join_transaction_mode="create_savepoint",
                    expire_on_commit=False,
                ) as db:
                    yield db

            for module in (settings, store, security):
                module.async_session_factory = sessions
            now = time.time()
            admin_id = uuid.uuid4()
            cfg = TrafficSettingsConfig(
                enabled=True,
                allowed_countries=["Norway"],
                sources=[
                    TrafficSourceConfig(
                        id=name,
                        label=name,
                        host_id=uuid.uuid4(),
                        kind="ssh" if name == "ssh" else "npm",
                        log_path="/var/log/test.log",
                    )
                    for name in ("media", "vpn", "ssh", "other")
                ],
            )
            async with sessions() as db, db.begin():
                row = await db.get(TrafficSettings, 1)
                assert row.value == {} and not (await settings.load_config(db)).enabled
                row.value = cfg.model_dump(mode="json", exclude={"revision"})
                db.add(
                    User(
                        id=admin_id,
                        username="test-admin",
                        password_hash="synthetic-unused",
                        role="admin",
                        is_active=True,
                    )
                )
            base = {
                "ts": now - 10,
                "ip": "8.8.8.8",
                "lat": None,
                "lon": None,
                "city": None,
                "country": "Germany",
                "domain": "app.example.com",
                "status": 200,
                "source": "media",
                "kind": "http",
                "suspicious": False,
            }

            def event(key, **kwargs):
                return {**base, "event_key": key.ljust(64, "x"), **kwargs}

            async with sessions() as db, db.begin():
                await store.save_batch(db, "media", [event("a")], {"offset": 10}, now)
                await store.save_batch(db, "media", [event("a")], {"offset": 10}, now)
            try:
                async with sessions() as db, db.begin():
                    await store.save_batch(
                        db, "media", [event("b")], {"offset": 20}, now
                    )
                    raise RuntimeError("Synthetic interrupted transaction")
            except RuntimeError:
                pass
            async with sessions() as db:
                assert await db.scalar(select(func.count()).select_from(E)) == 1
                assert (await db.get(C, "media")).checkpoint == {"offset": 10}
            assert (await store.snapshot(service="media"))["stats"]["total"] == 1
            assert (await store.snapshot(service="vpn"))["stats"]["total"] == 0
            # Exercise both age and row-cap retention with a valid configuration.
            async with sessions() as db, db.begin():
                row = await db.get(TrafficSettings, 1)
                row.value = {**row.value, "max_rows": 1000}
                await store.save_batch(
                    db,
                    "media",
                    [event(f"cap-{i}") for i in range(1005)]
                    + [event("old", ts=now - 40 * 86400)],
                    {},
                    now,
                )
                await store.cleanup(db, now)
                assert await db.scalar(select(func.count()).select_from(E)) == 1000
                assert await db.scalar(select(func.min(E.ts))) >= now - 30 * 86400
                await db.execute(delete(E))
                db.add(
                    C(
                        name="security",
                        checkpoint={
                            "started_at": now - 7200,
                            "cursor": 0,
                            "auth_cursor": 0,
                            "auth_started_at": now - 7200,
                            "last_notice": now,
                        },
                    )
                )
                await store.save_batch(
                    db,
                    "media",
                    [
                        event(
                            f"failure-{i}",
                            ts=now - 100 + i,
                            signal="auth_failure",
                            status=401,
                        )
                        for i in range(10)
                    ]
                    + [
                        event("success", signal="auth_success"),
                        event("other-success", source="other", signal="auth_success"),
                        event(
                            "ssh-success",
                            source="ssh",
                            kind="ssh",
                            signal="auth_success",
                            country="Norway",
                            status=None,
                        ),
                    ],
                    {},
                    now,
                )
            await security.scan_once(now)
            media = await security.security_snapshot("media")
            other = await security.security_snapshot("other")
            assert {a["rule"] for a in media["alerts"]} == {
                "auth_burst",
                "success_after_failures",
                "login_rejected",
                "foreign_login",
            }
            assert {a["rule"] for a in other["alerts"]} == {"foreign_login"}
            assert (await security.security_snapshot("ssh"))["alerts"][0][
                "rule"
            ] == "foreign_ssh"
            before = (await security.security_snapshot())["total"]
            await security.scan_once(now + 6)
            assert (await security.security_snapshot())["total"] == before
            # The same domain/IP on another source must have its own cooldown.
            assert (
                len(
                    [
                        a
                        for a in (await security.security_snapshot())["alerts"]
                        if a["rule"] == "foreign_login"
                    ]
                )
                == 2
            )
            from app.services import talk_watch

            security.get_settings = lambda: SimpleNamespace(
                talk_notifications_enabled=True,
                talk_memory_bindings=[
                    SimpleNamespace(user_id=admin_id, room_token="synthetic-room")
                ],
            )
            notices = []

            async def notice(*args):
                notices.append(args)
                return True

            talk_watch.notify_once = notice
            await security.notify_pending()
            assert len(notices) == 1 and "HIGH:" in notices[0][2]
            await security.notify_pending()
            assert len(notices) == 1
            # High-priority authentication bypasses the aggregate digest delay.
            async with sessions() as db, db.begin():
                item = auth.candidate(
                    {**base, "signal": "auth_success", "ts": now, "source": "media"},
                    {"countries": [], "addresses": []},
                )
                await auth.persist(db, item, now)
            await security.notify_pending()
            assert len(notices) == 2
            # Disabled sources cannot send old pending authentication alerts.
            async with sessions() as db, db.begin():
                row = await db.get(TrafficSettings, 1)
                row.value = {**row.value, "enabled": False}
                db.add(A(**item, created_at=now))
            await security.notify_pending()
            assert len(notices) == 2
            assert not (await security.authentication_banner())["enabled"]
            # More than one analysis batch must not lose delayed successes.
            policy = {"countries": [], "addresses": [], "source_ids": ["media"]}
            async with sessions() as db, db.begin():
                cursor = await db.scalar(select(func.max(E.id)))
                cp = {"auth_cursor": cursor, "auth_started_at": now - 1000}
                await store.save_batch(
                    db,
                    "media",
                    [event(f"burst-{i}", signal="auth_failure") for i in range(501)]
                    + [event("delayed-success", signal="auth_success", ts=now - 600)],
                    {},
                    now,
                )
                top = await db.scalar(select(func.max(E.id)))
                assert await auth.scan(db, cp, top, now, policy)
                assert cp["auth_cursor"] < top
                assert not await auth.scan(db, cp, top, now, policy)
                assert cp["auth_cursor"] == top
            # Locks coordinate separate database connections, not just coroutines.
            key = 739000000 + int(uuid.uuid4().hex[:6], 16)
            assert await connection.scalar(
                text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}
            )
            async with engine.connect() as other, other.begin():
                assert not await other.scalar(
                    text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": key}
                )
            for module in reversed(migrations):
                await connection.run_sync(lambda sync: migrate(sync, module.downgrade))
            assert (
                await connection.scalar(
                    text("SELECT to_regclass(:table)"),
                    {"table": schema + ".traffic_events"},
                )
                is None
            )
        finally:
            await outer.rollback()
    await engine.dispose()
    print(
        json.dumps(
            {
                "migration_up_down": True,
                "checkpoint_atomicity": True,
                "event_deduplication": True,
                "configured_filters": True,
                "retention_and_cap": True,
                "source_rule_isolation": True,
                "auth_cursor_no_loss": True,
                "talk_mocked": True,
                "disabled_sources_silent": True,
                "ha_lock_exclusive": True,
                "schema_rolled_back": True,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
