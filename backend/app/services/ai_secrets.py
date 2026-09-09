"""
AI provider API-key storage.

Deliberately not the Credential model's pattern (place a file on disk out
of band, then reference it) - the AI Agents page needs a plain "paste your
key here" text box, so ops-api itself writes the key file. To keep that
narrow, only secrets_root/ai-providers is mounted read-write into ops-api
(see compose.yml); the rest of the secrets tree (SSH credentials etc.)
stays read-only, unaffected by this.

The key is never returned by any GET endpoint and is redacted from the
audit log automatically (AuditLogMiddleware redacts any body key
containing "key").
"""
from pathlib import Path

from app.core.config import get_settings

_SUBDIR = "ai-providers"


def _provider_dir() -> Path:
    root = Path(get_settings().secrets_root).resolve()
    directory = (root / _SUBDIR).resolve()
    if not str(directory).startswith(str(root) + "/"):
        raise ValueError("invalid secrets root")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def write_provider_key(slug: str, api_key: str) -> str:
    """Writes the key to disk and returns the secret_path to store on the row."""
    directory = _provider_dir()
    target = (directory / f"{slug}.key").resolve()
    if target.parent != directory:
        raise ValueError("invalid provider slug")
    target.write_text(api_key.strip())
    target.chmod(0o600)
    return f"{_SUBDIR}/{slug}.key"


def delete_provider_key(secret_path: str) -> None:
    root = Path(get_settings().secrets_root).resolve()
    target = (root / secret_path).resolve()
    if not str(target).startswith(str(root) + "/"):
        raise ValueError("invalid secret_path")
    target.unlink(missing_ok=True)
