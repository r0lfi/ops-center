"""
Posting a bot message back into a Nextcloud Talk conversation - the reply
half of the webhook in app/api/routes/integrations.py. Signed with the
same shared secret (hex HMAC-SHA256 over random + message), per the Talk
bot API v1.
"""
import hashlib
import hmac
import os
import secrets

import httpx

from worker_ai.secrets import read_secret

TALK_BOT_SECRET_PATH = os.environ.get("TALK_BOT_SECRET_PATH", "integrations/talk-bot-secret")
# Nextcloud announces its own base URL in each webhook (X-Nextcloud-Talk-
# Backend) as its overwrite.cli.url - a public name that this container
# may not be able to resolve or reach. When set, replies go here instead.
TALK_BACKEND_URL = os.environ.get("TALK_BACKEND_URL", "").strip()
_MAX_MESSAGE = 6000


def post_message(backend: str, token: str, message: str, reply_to: str | None = None) -> None:
    secret = read_secret(TALK_BOT_SECRET_PATH)
    backend = TALK_BACKEND_URL or backend
    message = message.strip()[:_MAX_MESSAGE] or "(no answer)"
    random_value = secrets.token_hex(32)
    signature = hmac.new(secret.encode(), random_value.encode() + message.encode(), hashlib.sha256).hexdigest()
    payload: dict = {"message": message}
    if reply_to and reply_to.isdigit():
        payload["replyTo"] = int(reply_to)
    url = f"{backend.rstrip('/')}/ocs/v2.php/apps/spreed/api/v1/bot/{token}/message"
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            url,
            json=payload,
            headers={
                "OCS-APIRequest": "true",
                "Accept": "application/json",
                "X-Nextcloud-Talk-Bot-Random": random_value,
                "X-Nextcloud-Talk-Bot-Signature": signature,
            },
        )
        resp.raise_for_status()
