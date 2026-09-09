"""
Docker operations for AI tools, with the same local/remote split
app/api/routes/containers.py uses: on the Ops Center host itself the
Docker socket belongs to security-worker, so the call is a Celery RPC to
one of its tasks (blocking on the result, like host_ops.send_and_wait);
on any other managed host it's an Ansible playbook over SSH.
"""
import re

from app.core.config import get_settings
from worker_ai.ansible_ops import run_ansible_query
from worker_ai.celery_client import get_celery_client

# Same rule as containers.py's _DOCKER_NAME_RE - a real Docker name can't
# contain anything else, and container-control.yml passes it as one
# literal argv element regardless.
DOCKER_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]+$")
RPC_TIMEOUT = 45


def is_local_host(hostname: str) -> bool:
    return hostname == get_settings().ops_local_hostname


def local_rpc(task_name: str, args: list, timeout: int = RPC_TIMEOUT) -> dict:
    # Host-specific queue, not the shared "security" one - see
    # backend/app/services/host_ops.py's identical fix for why: two
    # security-workers (docker-01/docker-02) now share one Redis broker,
    # and only the local one has the matching docker.sock.
    queue = f"security.{get_settings().ops_local_hostname}"
    try:
        return get_celery_client().send_task(task_name, args=args, queue=queue).get(timeout=timeout)
    except Exception as exc:  # noqa: BLE001 - timeout or transport failure, reported not raised
        return {"available": False, "error": f"{task_name} failed on security-worker: {exc}"}


def docker_query(
    hostname: str, local_task: str, local_args: list, playbook: str, extra_vars: dict, list_key: str | None = None
) -> dict:
    """`list_key` names the key a bare-list result is wrapped under - some
    security-worker tasks (list_networks, list_images...) return a list
    where their playbook twin returns {list_key: [...]}, and callers want
    one shape."""
    if is_local_host(hostname):
        result = local_rpc(local_task, local_args)
        if isinstance(result, list):
            return {"available": True, list_key or "items": result}
        if not isinstance(result, dict):
            return {"available": True, "result": result}
        return {"available": True, **result} if "available" not in result else result
    return run_ansible_query(hostname, playbook, extra_vars)
