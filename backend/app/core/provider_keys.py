"""Encryption of AI provider API keys stored in the database.

Every node shares the database and API_SECRET_KEY, so a key saved through
one node's API is usable by the AI worker on any node. Key files under
secrets_root/ai-providers are local to one node and are kept only as a
fallback for keys saved before this existed.

The Fernet key is derived from API_SECRET_KEY with its own context, so it
differs from the MCP request cipher. Rotating API_SECRET_KEY makes stored
keys unreadable; they must then be saved again.
"""
import base64
import hashlib
import hmac

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

_CONTEXT = b"ops-center-ai-provider-keys-v1"


class ProviderKeyUnreadable(ValueError):
    pass


def _cipher() -> Fernet:
    key = hmac.new(get_settings().api_secret_key.encode(), _CONTEXT, hashlib.sha256).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_provider_key(api_key: str) -> str:
    return _cipher().encrypt(api_key.strip().encode()).decode()


def decrypt_provider_key(token: str) -> str:
    try:
        return _cipher().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ProviderKeyUnreadable("stored provider key cannot be decrypted; save the key again") from exc
