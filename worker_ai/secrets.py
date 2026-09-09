import os
from pathlib import Path

SECRETS_ROOT = Path(os.environ.get("SECRETS_ROOT", "/app/secrets")).resolve()


def read_secret(secret_path: str) -> str:
    """Resolves a secret_path (e.g. an AIProvider.secret_path) to its
    contents, refusing anything that would escape SECRETS_ROOT - same
    path-traversal guard as app/services/connectivity.py's _resolve_secret,
    kept as its own small copy since worker_ai doesn't import backend/app's
    services package (see redis_client.py's docstring for why)."""
    full = (SECRETS_ROOT / secret_path).resolve()
    if not str(full).startswith(str(SECRETS_ROOT) + "/"):
        raise ValueError("invalid secret_path")
    return full.read_text().strip()
