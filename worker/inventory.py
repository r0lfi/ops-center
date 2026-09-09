import os
from pathlib import Path

from app.models.host import Host

SECRETS_ROOT = Path(os.environ.get("SECRETS_ROOT", "/app/secrets")).resolve()


def _secret_path(relative: str) -> Path:
    resolved = (SECRETS_ROOT / relative).resolve()
    if not str(resolved).startswith(str(SECRETS_ROOT) + "/"):
        raise ValueError("credential secret_path escapes the secrets root")
    return resolved


def build_inventory(hosts: list[Host]) -> dict:
    """Builds an in-memory ansible-runner inventory - never a static file,
    and never anything that came from the DB gets shell-interpreted: values
    are placed directly as inventory vars."""
    inventory_hosts: dict[str, dict] = {}

    for host in hosts:
        host_vars: dict = {
            "ansible_host": host.ip_address,
            "ansible_port": host.ssh_port,
            "ansible_user": host.ssh_user,
            # host key checking is disabled in ansible.cfg; Ops Center's own
            # onboarding step separately records+displays the fingerprint
            # for operator review (see docs/security.md).
        }

        credential = host.credential
        if credential is not None:
            if credential.credential_type == "ssh_key":
                host_vars["ansible_ssh_private_key_file"] = str(_secret_path(credential.secret_path))
            elif credential.credential_type == "ssh_password":
                host_vars["ansible_password"] = _secret_path(credential.secret_path).read_text().strip()

        inventory_hosts[host.hostname] = host_vars

    return {"all": {"hosts": inventory_hosts}}
