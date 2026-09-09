"""Optional legacy wg-easy API integration on a trusted private network."""
import httpx
from fastapi import APIRouter, HTTPException

from app.schemas.vpn import VpnPeer, VpnPeerCreate

router = APIRouter()

from app.core.config import get_settings

_WG_EASY_URL = get_settings().wg_easy_url
_TIMEOUT = 5.0
_PEER_NOTES: dict[str, str] = {}


def _require_configured() -> None:
    if not _WG_EASY_URL:
        raise HTTPException(status_code=503, detail="VPN integration is not configured")


def _to_peer(c: dict) -> VpnPeer:
    return VpnPeer(
        id=c["id"],
        name=c["name"],
        address=c["address"],
        enabled=c["enabled"],
        latest_handshake_at=c.get("latestHandshakeAt"),
        transfer_rx=c.get("transferRx", 0),
        transfer_tx=c.get("transferTx", 0),
        note=_PEER_NOTES.get(c["name"]),
    )


async def _list_raw() -> list[dict]:
    _require_configured()
    try:
        async with httpx.AsyncClient(base_url=_WG_EASY_URL, timeout=_TIMEOUT) as client:
            resp = await client.get("/api/wireguard/client")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"wg-easy unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="wg-easy returned an error listing clients")
    return resp.json()


@router.get("/vpn/peers", response_model=list[VpnPeer])
async def list_peers() -> list[VpnPeer]:
    return [_to_peer(c) for c in await _list_raw()]


@router.post("/vpn/peers", response_model=VpnPeer)
async def create_peer(payload: VpnPeerCreate) -> VpnPeer:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    _require_configured()
    try:
        async with httpx.AsyncClient(base_url=_WG_EASY_URL, timeout=_TIMEOUT) as client:
            resp = await client.post("/api/wireguard/client", json={"name": name})
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"wg-easy unreachable: {exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"wg-easy rejected the new client ({resp.status_code})")

    # wg-easy's create response shape isn't relied on here - refetch by name
    # so this works whether it echoes the new client back or not.
    for c in await _list_raw():
        if c["name"] == name:
            return _to_peer(c)
    raise HTTPException(status_code=502, detail="client created but not found on refetch")


@router.delete("/vpn/peers/{peer_id}")
async def delete_peer(peer_id: str) -> dict:
    _require_configured()
    try:
        async with httpx.AsyncClient(base_url=_WG_EASY_URL, timeout=_TIMEOUT) as client:
            resp = await client.delete(f"/api/wireguard/client/{peer_id}")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"wg-easy unreachable: {exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"wg-easy rejected delete ({resp.status_code})")
    return {"ok": True}


@router.get("/vpn/peers/{peer_id}/config")
async def get_peer_config(peer_id: str) -> dict:
    _require_configured()
    try:
        async with httpx.AsyncClient(base_url=_WG_EASY_URL, timeout=_TIMEOUT) as client:
            resp = await client.get(f"/api/wireguard/client/{peer_id}/configuration")
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"wg-easy unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="wg-easy did not return a configuration")
    return {"configuration": resp.text}
