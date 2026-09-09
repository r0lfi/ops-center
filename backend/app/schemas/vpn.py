from pydantic import BaseModel


class VpnPeer(BaseModel):
    id: str
    name: str
    address: str
    enabled: bool
    latest_handshake_at: str | None = None
    transfer_rx: int = 0
    transfer_tx: int = 0
    # Set for peers whose client-side AllowedIPs was hand-restricted away
    # from wg-easy's full-tunnel default - see routes/vpn.py's _PEER_NOTES.
    note: str | None = None


class VpnPeerCreate(BaseModel):
    name: str
