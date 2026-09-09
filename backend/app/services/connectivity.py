import asyncio
import time
from pathlib import Path

import asyncssh

from app.core.config import get_settings
from app.models.host import Credential

TCP_TIMEOUT = 5
SSH_TIMEOUT = 8


async def check_tcp(ip: str, port: int) -> tuple[bool, str]:
    """Raw TCP reachability check - no SSH/Ansible involved."""
    start = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(ip, port), timeout=TCP_TIMEOUT)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        elapsed_ms = (time.monotonic() - start) * 1000
        return True, f"TCP connect to {ip}:{port} succeeded in {elapsed_ms:.0f}ms"
    except Exception as exc:
        return False, f"TCP connect to {ip}:{port} failed: {exc}"


def _resolve_secret(secret_path: str) -> Path:
    settings = get_settings()
    root = Path(settings.secrets_root).resolve()
    candidate = (root / secret_path).resolve()
    if not str(candidate).startswith(str(root) + "/") and candidate != root:
        raise ValueError("credential secret_path escapes the secrets root")
    return candidate


class _PinnedHostKeyClient(asyncssh.SSHClient):
    """Custom SSHClient used only to intercept host-key validation.

    We pass known_hosts=None below because we don't maintain an OpenSSH
    known_hosts file - the trusted fingerprint lives on the Host row
    instead (ssh_host_fingerprint, recorded on first contact). But
    known_hosts=None on its own means asyncssh performs NO verification
    at all: every connection - not just the first - would silently accept
    whatever key the server presents. Overriding validate_host_public_key
    via client_factory is what actually enforces the pin on every
    connection after the first. This runs during key exchange, before any
    authentication data (including a plaintext password credential) is
    sent, so a rejected key aborts before the credential ever reaches the
    other end.
    """

    def __init__(self, expected_fingerprint: str | None):
        self._expected_fingerprint = expected_fingerprint
        self.rejected_fingerprint: str | None = None

    def validate_host_public_key(self, host, addr, port, key) -> bool:
        if self._expected_fingerprint is None:
            return True  # trust-on-first-use: nothing recorded yet for this host
        fingerprint = key.get_fingerprint()
        if fingerprint == self._expected_fingerprint:
            return True
        self.rejected_fingerprint = fingerprint
        return False


async def check_ssh(
    ip: str,
    port: int,
    username: str,
    credential: Credential | None,
    expected_fingerprint: str | None = None,
) -> tuple[bool, str, str | None]:
    """
    Attempt a real SSH connection using the referenced credential.

    If expected_fingerprint is set (i.e. we've already onboarded this host
    once), the server's host key is verified against it during the
    handshake - a mismatch aborts the connection before authentication, so
    a MITM'd or reinstalled host is reported as a failure instead of
    silently re-trusted. If expected_fingerprint is None, this is
    trust-on-first-use: whatever key is presented is accepted and returned
    so the caller can record it.

    Returns (auth_ok, detail, host_key_fingerprint). The fingerprint is only
    captured on a successful authenticated connection: asyncssh does not
    expose the negotiated host key when authentication fails partway through
    the handshake, so a failed/skipped auth also blocks fingerprint capture
    (surfaced as a separate onboarding step, not silently skipped).
    """
    if credential is None:
        return False, "no credential configured for this host - SSH auth check skipped", None

    try:
        secret_file = _resolve_secret(credential.secret_path)
    except ValueError as exc:
        return False, str(exc), None

    if not secret_file.exists():
        return False, f"credential secret file not found: {credential.secret_path}", None

    client_holder: dict[str, _PinnedHostKeyClient] = {}

    def _client_factory() -> _PinnedHostKeyClient:
        client = _PinnedHostKeyClient(expected_fingerprint)
        client_holder["client"] = client
        return client

    connect_kwargs: dict = dict(
        host=ip,
        port=port,
        username=username,
        known_hosts=None,  # verification is done by _PinnedHostKeyClient above instead
        client_factory=_client_factory,
        connect_timeout=SSH_TIMEOUT,
    )

    if credential.credential_type == "ssh_key":
        try:
            client_key = asyncssh.import_private_key(secret_file.read_text())
        except Exception as exc:
            return False, f"could not parse private key {credential.secret_path}: {exc}", None
        connect_kwargs["client_keys"] = [client_key]
    elif credential.credential_type == "ssh_password":
        connect_kwargs["password"] = secret_file.read_text().strip()
        connect_kwargs["client_keys"] = []
    else:
        return False, f"unsupported credential_type: {credential.credential_type}", None

    try:
        async with asyncssh.connect(**connect_kwargs) as conn:
            host_key = conn.get_server_host_key()
            fingerprint = host_key.get_fingerprint() if host_key else None
            return True, "SSH authentication succeeded", fingerprint
    except asyncssh.PermissionDenied as exc:
        return False, f"SSH authentication failed: {exc}", None
    except (OSError, asyncssh.Error, asyncio.TimeoutError) as exc:
        client = client_holder.get("client")
        if client is not None and client.rejected_fingerprint:
            return (
                False,
                "SSH host key does not match the fingerprint recorded during onboarding "
                f"(expected {expected_fingerprint}, presented {client.rejected_fingerprint}). "
                "Refusing to connect - this can mean the host was reinstalled/rekeyed "
                "legitimately, or that something else is now answering on this IP. Clear "
                "ssh_host_fingerprint on the host if you've confirmed it's expected.",
                None,
            )
        return False, f"SSH connection failed: {exc}", None
