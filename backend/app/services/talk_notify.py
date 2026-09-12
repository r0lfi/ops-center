"""Signed outbound messages to one configured Nextcloud backend."""

import hashlib
import hmac
import json
import secrets
import httpx
from app.core.config import get_settings
from app.services.connectivity import _resolve_secret


async def send_talk(token, message):
    settings = get_settings()
    backend = settings.talk_backend_url.rstrip("/")
    if not backend.startswith("https://"):
        raise ValueError("A trusted HTTPS Talk backend must be configured")
    secret = _resolve_secret(settings.talk_bot_secret_path).read_text().strip()
    message = message.strip()[:5900]
    random = secrets.token_hex(32)
    signature = hmac.new(
        secret.encode(), (random + message).encode(), hashlib.sha256
    ).hexdigest()
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            f"{backend}/ocs/v2.php/apps/spreed/api/v1/bot/{token}/message",
            json={"message": message},
            headers={
                "OCS-APIRequest": "true",
                "Accept": "application/json",
                "X-Nextcloud-Talk-Bot-Random": random,
                "X-Nextcloud-Talk-Bot-Signature": signature,
            },
        )
        response.raise_for_status()
        if response.json().get("ocs", {}).get("meta", {}).get("status") != "ok":
            raise RuntimeError("Talk did not acknowledge message")
