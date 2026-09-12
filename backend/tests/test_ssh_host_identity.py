"""Exercise real loopback SSH handshakes; never contact infrastructure."""

import asyncio
from types import SimpleNamespace

import asyncssh

from app.services.connectivity import check_ssh
from app.services.traffic_watch import _RemoteTail


def test_wrong_host_key_is_rejected_before_password_is_sent(tmp_path, monkeypatch):
    password_file = tmp_path / "password"
    password_file.write_text("synthetic-test-password")
    monkeypatch.setattr(
        "app.services.connectivity._resolve_secret", lambda _: password_file
    )
    monkeypatch.setattr(
        "app.services.traffic_watch._resolve_secret", lambda _: password_file
    )
    attempts = []

    class Server(asyncssh.SSHServer):
        def begin_auth(self, username):
            return True

        def password_auth_supported(self):
            return True

        def validate_password(self, username, password):
            attempts.append(username)
            return password == "synthetic-test-password"

    async def run():
        key = asyncssh.generate_private_key("ssh-ed25519")
        server = await asyncssh.create_server(
            Server, "127.0.0.1", 0, server_host_keys=[key]
        )
        credential = SimpleNamespace(
            secret_path="password", credential_type="ssh_password"
        )
        host = SimpleNamespace(
            credential=credential,
            ip_address="127.0.0.1",
            ssh_port=server.get_port(),
            ssh_user="synthetic",
            ssh_host_fingerprint="SHA256:wrong",
        )
        try:
            ok, _, _ = await check_ssh(
                host.ip_address,
                host.ssh_port,
                host.ssh_user,
                credential,
                "SHA256:wrong",
            )
            assert not ok and attempts == []
            tail = _RemoteTail(host)
            try:
                try:
                    await tail.run("true")
                except asyncssh.HostKeyNotVerifiable:
                    pass
                else:
                    raise AssertionError("Wrong fingerprint was accepted")
            finally:
                await tail.close()
            assert attempts == []
            ok, _, fingerprint = await check_ssh(
                host.ip_address,
                host.ssh_port,
                host.ssh_user,
                credential,
                key.get_fingerprint(),
            )
            assert (
                ok
                and fingerprint == key.get_fingerprint()
                and attempts == ["synthetic"]
            )
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())
