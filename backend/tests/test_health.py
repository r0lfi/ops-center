import asyncio
import time

import pytest

from app.api.routes import health as health_route


@pytest.fixture(autouse=True)
def fresh_health_state(monkeypatch):
    monkeypatch.setattr(health_route, "_cached_result", None)
    monkeypatch.setattr(health_route, "_cached_at", 0.0)
    monkeypatch.setattr(health_route, "_running", None)


async def _ok() -> bool:
    return True


async def _false() -> bool:
    return False


async def _boom() -> bool:
    raise RuntimeError("down")


async def _hangs() -> bool:
    await asyncio.sleep(60)
    return True


@pytest.mark.asyncio
async def test_status_maps_results_to_ok_and_error():
    assert await health_route._status(_ok) == "ok"
    assert await health_route._status(_false) == "error"
    assert await health_route._status(_boom) == "error"


@pytest.mark.asyncio
async def test_a_hanging_check_cannot_hold_the_endpoint(monkeypatch):
    monkeypatch.setattr(health_route, "_CHECK_TIMEOUT", 0.05)
    started = time.monotonic()
    assert await health_route._status(_hangs) == "error"
    assert time.monotonic() - started < 1


@pytest.mark.asyncio
async def test_failed_dependencies_report_degraded_without_raising(monkeypatch):
    monkeypatch.setattr(health_route, "_database_ok", _boom)
    monkeypatch.setattr(health_route, "_redis_ok", _ok)
    monkeypatch.setattr(health_route, "_security_feeds_ok", _ok)
    monkeypatch.setattr(health_route, "_http_ok", lambda url: _ok())
    result = await health_route.health()
    assert result["status"] == "degraded"
    assert result["components"]["database"] == "error"
    assert result["components"]["redis"] == "ok"
    assert set(result["components"]) >= {"prometheus", "alertmanager", "grafana"}


@pytest.mark.asyncio
async def test_concurrent_and_repeated_callers_share_one_set_of_checks(monkeypatch):
    calls = 0

    async def counted() -> dict:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"status": "ok"}

    monkeypatch.setattr(health_route, "_collect", counted)
    await asyncio.gather(*(health_route.health() for _ in range(50)))
    await health_route.health()
    assert calls == 1

    monkeypatch.setattr(health_route, "_cached_at", time.monotonic() - health_route._RESULT_TTL - 1)
    await health_route.health()
    assert calls == 2
