"""
Reconstructs an equivalent compose.yml directly from live `docker inspect`
data for containers Docker already knows belong together via their
com.docker.compose.project/service labels - never from the project's
original compose file. Verified live while building this that the file
path Docker records for a compose project (`docker compose ls`'s
ConfigFiles) isn't reliably a real, persisted file on disk - confirmed for
a Portainer Edge Agent-deployed stack on ops-host, where that path
turned out not to exist at all. Inspect data is always available regardless
of how/where a stack was originally deployed, so that's the only
reconstruction source this module trusts.

Known, documented gaps - left for a human to catch in the mandatory
preview-before-deploy step every caller of reconstruct_compose routes
through (same principle as app_templates.py's render path): command/
entrypoint overrides, depends_on ordering, and custom (non-default)
network topology are not reconstructed.
"""

import yaml

_PROJECT_LABEL = "com.docker.compose.project"
_SERVICE_LABEL = "com.docker.compose.service"


def group_by_project(raw_containers: list[dict]) -> dict[str, list[dict]]:
    projects: dict[str, list[dict]] = {}
    for c in raw_containers:
        project = (c.get("Config", {}).get("Labels") or {}).get(_PROJECT_LABEL)
        if project:
            projects.setdefault(project, []).append(c)
    return projects


def _reconstruct_ports(host_config: dict) -> list[str]:
    ports = []
    for container_port, bindings in (host_config.get("PortBindings") or {}).items():
        for binding in bindings or []:
            host_port = binding.get("HostPort")
            if host_port:
                ports.append(f"{host_port}:{container_port}")
    return ports


def _reconstruct_volumes(project: str, mounts: list[dict]) -> tuple[list[str], dict[str, dict]]:
    # Compose names a project's volumes "<project>_<volume>" on disk -
    # stripping that prefix back off and declaring the short name bare
    # (not `external`) means a redeploy under the *same* project/stack
    # name resolves to this exact existing volume, not a fresh empty one.
    #
    # Not every named volume follows that convention, though - a plain
    # container-only path (no named volume declared in the original
    # compose file) becomes a genuinely *anonymous* Docker volume (a bare
    # random hex id, no project prefix at all). Verified hitting exactly
    # this live: unifi-db's /data/configdb mount is one - a bare
    # declaration for it would get Compose's usual <project>_ prefix
    # applied on redeploy, resolving to a *different*, fresh, empty
    # volume and silently discarding real MongoDB data. `external: true`
    # with its exact current name is the only safe reference for these.
    volume_lines = []
    top_level_volumes: dict[str, dict] = {}
    for m in mounts or []:
        destination = m.get("Destination", "")
        if not destination:
            continue
        if m.get("Type") == "bind":
            source = m.get("Source", "")
            if source:
                volume_lines.append(f"{source}:{destination}")
        elif m.get("Type") == "volume":
            name = m.get("Name", "")
            if not name:
                continue
            prefix = f"{project}_"
            if name.startswith(prefix):
                short_name = name[len(prefix) :]
                volume_lines.append(f"{short_name}:{destination}")
                top_level_volumes.setdefault(short_name, {})
            else:
                volume_lines.append(f"{name}:{destination}")
                top_level_volumes.setdefault(name, {"external": True})
    return volume_lines, top_level_volumes


def reconstruct_compose(project: str, containers: list[dict]) -> str:
    services: dict[str, dict] = {}
    all_top_volumes: dict[str, dict] = {}

    for c in containers:
        labels = c.get("Config", {}).get("Labels") or {}
        service_name = labels.get(_SERVICE_LABEL) or (c.get("Name") or "service").lstrip("/")
        host_config = c.get("HostConfig", {})

        service: dict = {"image": c.get("Config", {}).get("Image", "")}

        container_name = (c.get("Name") or "").lstrip("/")
        if container_name:
            service["container_name"] = container_name

        ports = _reconstruct_ports(host_config)
        if ports:
            service["ports"] = ports

        volume_lines, top_volumes = _reconstruct_volumes(project, c.get("Mounts") or [])
        if volume_lines:
            service["volumes"] = volume_lines
        all_top_volumes.update(top_volumes)

        env = c.get("Config", {}).get("Env") or []
        if env:
            service["environment"] = env

        if host_config.get("NetworkMode") == "host":
            service["network_mode"] = "host"

        restart = (host_config.get("RestartPolicy") or {}).get("Name")
        if restart and restart != "no":
            service["restart"] = restart

        services[service_name] = service

    compose: dict = {"services": services}
    if all_top_volumes:
        compose["volumes"] = all_top_volumes

    return yaml.safe_dump(compose, sort_keys=False, default_flow_style=False)
