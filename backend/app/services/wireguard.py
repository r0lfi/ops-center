"""Server-side wg-easy v14 session authentication over verified HTTPS."""
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import HTTPException

from app.core.config import get_settings


def _password() -> str:
    settings = get_settings()
    root = Path(settings.secrets_root).resolve()
    path = (root / settings.wireguard_password_path).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(503, "WireGuard integration credentials are not configured")
    try:
        password = path.read_text().strip()
    except (OSError, UnicodeError):
        raise HTTPException(503, "WireGuard integration credentials are not configured") from None
    if not password:
        raise HTTPException(503, "WireGuard integration credentials are not configured")
    return password


@asynccontextmanager
async def wireguard_client():
    settings = get_settings()
    if httpx.URL(settings.wireguard_url).scheme != "https":
        raise HTTPException(503, "WireGuard integration requires HTTPS")
    password = _password()
    async with httpx.AsyncClient(
        base_url=settings.wireguard_url, timeout=5.0,
        follow_redirects=False, trust_env=False,
    ) as client:
        try:
            login = await client.post("/api/session", json={"password": password})
        except httpx.HTTPError:
            raise HTTPException(502, "WireGuard could not be reached for sign-in") from None
        if login.status_code in (401, 403):
            raise HTTPException(503, "WireGuard integration sign-in was rejected; check its stored credential and access rule")
        if login.status_code != 200 or not client.cookies:
            raise HTTPException(502, "WireGuard did not establish an authenticated session")
        try:
            yield client
        finally:
            # Per-operation session, no shared browser cookie or credential exposure.
            # Never retry a mutation after an ambiguous transport failure.
            try:
                await client.delete("/api/session")
            except httpx.HTTPError:
                pass
