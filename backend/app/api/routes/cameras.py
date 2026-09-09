"""Optional camera status and streams, configured through environment settings."""
import asyncio
import json

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.schemas.cameras import CameraStatus
from app.services.auth import decode_access_token
from app.services.redis_client import get_redis_client

router = APIRouter()

# A second, separate router (mirrors app/api/routes/ai.py's stream_router) -
# an <img>/<video> element can't send an Authorization header, so this one
# route authenticates via a `token` query param instead of the blanket
# dependencies=_AUTH every other router here gets in main.py.
stream_router = APIRouter()

from app.core.config import get_settings

_CAMERAS = get_settings().cameras
_CHECK_TIMEOUT = 2.0
_STREAMED_CAMERAS = frozenset(get_settings().streamed_cameras)
_GO2RTC_URL = get_settings().go2rtc_url


async def _is_reachable(ip: str, port: int) -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=_CHECK_TIMEOUT)
        writer.close()
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def _camera_status(name: str, ip: str, port: int, kind: str) -> CameraStatus:
    redis_client = get_redis_client()
    reachable = await _is_reachable(ip, port)

    fails_raw = await redis_client.get(f"camera_watchdog:fails:{name}")
    cooldown_ttl = await redis_client.ttl(f"camera_watchdog:cooldown:{name}")
    last_kick_raw = await redis_client.get(f"camera_watchdog:last_kick:{name}")

    last_kick_at = None
    last_kick_result = None
    if last_kick_raw:
        try:
            last_kick = json.loads(last_kick_raw)
            last_kick_at = last_kick.get("at")
            last_kick_result = last_kick.get("result")
        except ValueError:
            pass

    return CameraStatus(
        name=name,
        ip=ip,
        kind=kind,
        reachable=reachable,
        consecutive_fails=int(fails_raw) if fails_raw else 0,
        cooldown_remaining_seconds=cooldown_ttl if cooldown_ttl and cooldown_ttl > 0 else None,
        last_kick_at=last_kick_at,
        last_kick_result=last_kick_result,
        has_stream=name in _STREAMED_CAMERAS,
    )


@router.get("/cameras/status", response_model=list[CameraStatus])
async def get_cameras_status() -> list[CameraStatus]:
    return [await _camera_status(name, ip, port, kind) for name, ip, port, kind in _CAMERAS]


@stream_router.get("/cameras/{name}/stream.mjpeg")
async def stream_camera(name: str, token: str):
    if decode_access_token(token) is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    if name not in _STREAMED_CAMERAS:
        raise HTTPException(status_code=404, detail="no live stream configured for this camera")

    client = httpx.AsyncClient(timeout=None)
    req = client.build_request("GET", f"{_GO2RTC_URL}/api/stream.mjpeg", params={"src": name})
    upstream = await client.send(req, stream=True)
    if upstream.status_code != 200:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=502, detail="go2rtc did not return a stream")

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        media_type=upstream.headers.get("content-type", "multipart/x-mixed-replace"),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
