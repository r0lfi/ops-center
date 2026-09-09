"""Optional UniFi camera recovery. Credentials: secrets/integrations/unifi-controller.json."""
import json
from pathlib import Path

import httpx

from app.core.config import get_settings

_BASE_URL = get_settings().unifi_url
_TIMEOUT = 10.0
_CREDENTIALS_PATH = "integrations/unifi-controller.json"


class UnifiCredentialsMissing(Exception):
    pass


def _load_credentials() -> dict:
    root = Path(get_settings().secrets_root).resolve()
    path = (root / _CREDENTIALS_PATH).resolve()
    if not str(path).startswith(str(root) + "/") or not path.exists():
        raise UnifiCredentialsMissing(
            f"no UniFi controller credentials at {root / _CREDENTIALS_PATH} - "
            "create it by hand, see worker/unifi_client.py"
        )
    return json.loads(path.read_text())


class UnifiClient:
    """One short-lived authenticated session. Not reused across calls -
    the watchdog only calls this after a camera has already been down for
    several minutes, so a fresh login each time is simpler than keeping a
    session alive and worrying about cookie expiry."""

    def __init__(self):
        if not _BASE_URL:
            raise UnifiCredentialsMissing("UniFi integration is not configured")
        creds = _load_credentials()
        self._client = httpx.Client(base_url=_BASE_URL, verify=get_settings().unifi_verify_tls, timeout=_TIMEOUT)
        resp = self._client.post(
            "/api/login", json={"username": creds["username"], "password": creds["password"]}
        )
        resp.raise_for_status()

    def find_mac_by_ip(self, ip: str) -> str | None:
        resp = self._client.get("/api/s/default/stat/sta")
        resp.raise_for_status()
        for station in resp.json().get("data", []):
            if station.get("ip") == ip:
                return station.get("mac")
        return None

    def kick_sta(self, mac: str) -> None:
        resp = self._client.post("/api/s/default/cmd/stamgr", json={"cmd": "kick-sta", "mac": mac})
        resp.raise_for_status()

    def close(self) -> None:
        self._client.close()


def kick_camera(ip: str) -> bool:
    """Looks up the current MAC for `ip` and kicks it off WiFi so it
    re-associates. Returns False (no exception) if the IP isn't currently a
    known WiFi client - nothing to kick, not an error worth crashing the
    beat task over."""
    client = UnifiClient()
    try:
        mac = client.find_mac_by_ip(ip)
        if mac is None:
            return False
        client.kick_sta(mac)
        return True
    finally:
        client.close()
