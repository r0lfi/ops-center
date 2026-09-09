"""
list_containers / get_container_vulnerabilities tools for the Containers Agent.

Reads the containers table directly (kept in sync by security-worker's
inventory poll - see app/api/routes/containers.py's GET /containers for
the same data), not a live Docker call - matching get_patch_status's
"read what's already collected" pattern. No start/stop/restart tool here:
those go through security-worker's docker.sock (local host) or
container-control.yml (remote), a Celery RPC path this worker doesn't
have a client for yet.
"""
from sqlalchemy import func, select

from app.models.container import Container
from app.models.vulnerability import ContainerVulnerability, Vulnerability
from worker_ai.db import SessionLocal
from worker_ai.docker_ops import DOCKER_NAME_RE, docker_query

_MAX_CONTAINERS_TO_MODEL = 100
_MAX_LOG_LINES = 200

CONTAINER_LOGS_SCHEMA = {
    "name": "get_container_logs",
    "description": (
        "The most recent log lines from one container on one Docker host, live from Docker. "
        "Returns available=false if the host or security-worker couldn't be reached - never "
        "guess at log contents in that case."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hostname": {"type": "string"},
            "name": {"type": "string", "description": "Container name"},
            "tail": {"type": "integer", "description": "How many lines, default 100 (max 200)", "default": 100},
        },
        "required": ["hostname", "name"],
    },
}

DOCKER_NETWORKS_SCHEMA = {
    "name": "list_docker_networks",
    "description": (
        "Docker networks on one host - name, driver, subnet/gateway and which containers are "
        "attached - live from Docker. Returns available=false if the host couldn't be reached."
    ),
    "parameters": {"type": "object", "properties": {"hostname": {"type": "string"}}, "required": ["hostname"]},
}


def get_container_logs(hostname: str, name: str, tail: int = 100) -> dict:
    if not DOCKER_NAME_RE.match(name):
        return {"available": False, "error": f"{name!r} is not a valid container name"}
    tail = max(1, min(int(tail), _MAX_LOG_LINES))
    result = docker_query(hostname, "security.tasks.container_logs", [name, tail], "docker-logs.yml", {"container_name": name, "tail_lines": tail})
    if result.get("available") is False:
        return result
    return {"available": True, "hostname": hostname, "container": name, "lines": (result.get("lines") or [])[-tail:]}


CONTAINER_ENV_KEYS_SCHEMA = {
    "name": "get_container_env_keys",
    "description": (
        "The environment variable NAMES configured for one container - never their values, so "
        "this can't leak a secret. Use it to check whether a required credential/config variable "
        "is set at all (e.g. an API key), before assuming a failure is that variable's fault. "
        "Live from Docker. Returns available=false if the host couldn't be reached."
    ),
    "parameters": {
        "type": "object",
        "properties": {"hostname": {"type": "string"}, "name": {"type": "string", "description": "Container name"}},
        "required": ["hostname", "name"],
    },
}


def get_container_env_keys(hostname: str, name: str) -> dict:
    if not DOCKER_NAME_RE.match(name):
        return {"available": False, "error": f"{name!r} is not a valid container name"}
    result = docker_query(hostname, "security.tasks.inspect_container", [name], "docker-inspect.yml", {"container_name": name})
    if result.get("available") is False:
        return result
    # local security-worker RPC returns the raw `docker inspect` dict with
    # its fields at the top level; the remote Ansible path always includes
    # a literal "inspect" key (null when not found) - see docker-inspect.yml.
    inspect = result["inspect"] if "inspect" in result else result
    if not inspect:
        return {"available": False, "error": f"container {name!r} not found on {hostname!r}"}
    env_list = ((inspect.get("Config") or {}).get("Env")) or []
    keys = sorted({entry.split("=", 1)[0] for entry in env_list if "=" in entry})
    return {"available": True, "hostname": hostname, "container": name, "env_keys": keys}


def list_docker_networks(hostname: str) -> dict:
    result = docker_query(hostname, "security.tasks.list_networks", [], "docker-networks.yml", {}, list_key="networks")
    if result.get("available") is False:
        return result
    raw = result.get("networks") or []
    networks = []
    for net in raw:
        ipam = ((net.get("IPAM") or {}).get("Config") or [{}])[0]
        networks.append(
            {
                "name": net.get("Name"),
                "driver": net.get("Driver"),
                "subnet": ipam.get("Subnet"),
                "gateway": ipam.get("Gateway"),
                "containers": [c.get("Name") for c in (net.get("Containers") or {}).values()],
            }
        )
    return {"available": True, "hostname": hostname, "networks": networks}

LIST_CONTAINERS_SCHEMA = {
    "name": "list_containers",
    "description": (
        "Every container Ops Center currently tracks (optionally filtered to one Docker host): "
        "name, image, status, health, restart count, and vulnerability count. Read from the "
        "already-synced inventory, not a live Docker call."
    ),
    "parameters": {
        "type": "object",
        "properties": {"hostname": {"type": "string", "description": "Optional - filter to one Docker host"}},
        "required": [],
    },
}

CONTAINER_VULNS_SCHEMA = {
    "name": "get_container_vulnerabilities",
    "description": (
        "CVEs affecting one container's image, by container name. Not host-scoped - a limitation "
        "shared with the Containers page itself: a same-named container on two different hosts "
        "would collide here."
    ),
    "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
}


def list_containers(hostname: str | None = None) -> dict:
    with SessionLocal() as db:
        query = select(Container).order_by(Container.hostname, Container.name)
        if hostname is not None:
            query = query.where(Container.hostname == hostname)
        containers = db.execute(query).scalars().all()[:_MAX_CONTAINERS_TO_MODEL]

        counts = dict(
            db.execute(
                select(ContainerVulnerability.container_name, func.count(ContainerVulnerability.id)).group_by(
                    ContainerVulnerability.container_name
                )
            ).all()
        )

        return {
            "available": True,
            "containers": [
                {
                    "hostname": c.hostname,
                    "name": c.name,
                    "image": c.image,
                    "status": c.status,
                    "health": c.health,
                    "restart_count": c.restart_count,
                    "vulnerability_count": counts.get(c.name, 0),
                }
                for c in containers
            ],
        }


def get_container_vulnerabilities(name: str) -> dict:
    with SessionLocal() as db:
        rows = db.execute(
            select(ContainerVulnerability, Vulnerability)
            .join(Vulnerability, Vulnerability.id == ContainerVulnerability.vulnerability_id)
            .where(ContainerVulnerability.container_name == name)
            .order_by(Vulnerability.severity, Vulnerability.cve_id)
        ).all()
        return {
            "available": True,
            "container": name,
            "vulnerabilities": [
                {
                    "cve_id": v.cve_id,
                    "severity": v.severity,
                    "cvss_score": v.cvss_score,
                    "package": v.package_name,
                    "installed_version": cv.installed_version,
                    "fixed_version": v.fixed_version,
                    "fix_available": v.fix_available,
                }
                for cv, v in rows
            ],
        }
