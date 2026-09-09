"""
Container start/stop/restart and docker-compose stack deploy/remove.

Deliberately the ONLY module in the whole app that writes to docker.sock -
security-worker is already the one component with socket access (for Trivy
scanning and the read-only container-status sync), so extending its scope
here keeps the isolation principle intact ("only one component touches
docker.sock") rather than adding a second one. See docs/security.md for the
full risk discussion: stack deploy in particular is unrestricted container
creation (arbitrary bind mounts, privileged mode, host networking) and is
treated as equivalent to root on the host - admin-only, audit-logged by the
existing middleware on every route that reaches this module.
"""

import json
import os
import re
import socket as socket_module
import subprocess
import threading
from pathlib import Path

import docker

from security.redis_client import get_redis_client

STACKS_ROOT = Path(os.environ.get("DOCKER_STACKS_ROOT", "/data/docker-stacks"))
_STACK_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
COMPOSE_TIMEOUT_SECONDS = 300
QUERY_TIMEOUT_SECONDS = 30
_ALLOWED_CONTAINER_ACTIONS = ("start", "stop", "restart")


class InvalidStackName(ValueError):
    pass


# Module-level singleton (see security/tasks.py's identical _docker() for
# why): a fresh docker.from_env() per call leaks a docker.sock connection
# that's never closed.
_docker_client: docker.DockerClient | None = None


def _client() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def _validate_stack_name(name: str) -> Path:
    if not _STACK_NAME_RE.match(name):
        raise InvalidStackName(
            "stack name must be lowercase alphanumeric with dashes/underscores, max 63 chars"
        )
    path = (STACKS_ROOT / name).resolve()
    if path.parent != STACKS_ROOT.resolve():
        raise InvalidStackName("invalid stack name")
    return path


def container_action(name: str, action: str) -> dict:
    """action: start | stop | restart"""
    if action not in _ALLOWED_CONTAINER_ACTIONS:
        # This module is documented above as the one place with
        # docker.sock access, equivalent to root on the host - the
        # whitelist has to hold here even if a future caller (a new task,
        # a script) forgets to check `action` itself before calling in.
        # Without it, getattr(container, action)() would call *any*
        # docker-py Container method with no arguments, not just these three.
        raise ValueError(f"action must be one of {_ALLOWED_CONTAINER_ACTIONS}, got {action!r}")
    try:
        container = _client().containers.get(name)
        getattr(container, action)()
        return {"ok": True, "message": f"{action} succeeded"}
    except docker.errors.NotFound:
        return {"ok": False, "message": f"container '{name}' not found"}
    except docker.errors.APIError as exc:
        return {"ok": False, "message": str(exc)}


_EXEC_OUTPUT_MAX_CHARS = 8000


def container_exec(name: str, command: str) -> dict:
    """Runs one command inside a container via `sh -c` and returns its
    output - the AI Containers Agent's container_exec tool
    (worker_ai/ai/tools/exec_tools.py), always approval-gated the same as
    run_shell_command: this is unrestricted execution, just scoped to
    inside a container instead of the host."""
    try:
        container = _client().containers.get(name)
    except docker.errors.NotFound:
        return {"ok": False, "message": f"container '{name}' not found"}
    except docker.errors.APIError as exc:
        return {"ok": False, "message": str(exc)}
    try:
        exit_code, output = container.exec_run(["sh", "-c", command], demux=False)
    except docker.errors.APIError as exc:
        return {"ok": False, "message": str(exc)}
    text = output.decode("utf-8", errors="replace") if isinstance(output, (bytes, bytearray)) else str(output or "")
    return {"ok": True, "exit_code": exit_code, "output": text[:_EXEC_OUTPUT_MAX_CHARS]}


def _run_docker(args: list[str], timeout: int = QUERY_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    # Shells out to the same vendored `docker` CLI binary deploy_stack()
    # below already uses (DOCKER_HOST=unix:///var/run/docker.sock is set on
    # this container - see compose.yml), rather than docker-py, so these
    # read-only query functions return exactly the same JSON shape
    # (`docker inspect`/`docker network inspect`/etc output) as the
    # equivalent remote-host Ansible playbooks (docker-images.yml and
    # friends) get by running the identical commands over SSH. One
    # normalization path in the API layer instead of two.
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=False)


def list_images() -> list[dict]:
    ids = _run_docker(["image", "ls", "-q"]).stdout.split()
    if not ids:
        return []
    result = _run_docker(["inspect", *ids])
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []


def list_networks() -> list[dict]:
    ids = _run_docker(["network", "ls", "-q"]).stdout.split()
    if not ids:
        return []
    result = _run_docker(["network", "inspect", *ids])
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []


def list_volumes() -> list[dict]:
    names = _run_docker(["volume", "ls", "-q"]).stdout.split()
    if not names:
        return []
    result = _run_docker(["volume", "inspect", *names])
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []


def container_logs(name: str, tail: int) -> dict:
    result = _run_docker(["logs", "--tail", str(tail), name])
    lines = (result.stdout + result.stderr).splitlines()
    return {"ok": result.returncode == 0, "lines": lines}


def container_stats(name: str) -> dict:
    result = _run_docker(["stats", "--no-stream", "--format", "{{json .}}", name])
    if result.returncode != 0 or not result.stdout.strip():
        return {}
    return json.loads(result.stdout.strip())


def inspect_container(name: str) -> dict | None:
    result = _run_docker(["inspect", name])
    if result.returncode != 0 or not result.stdout.strip():
        return None
    data = json.loads(result.stdout)
    return data[0] if data else None


def list_stacks() -> list[str]:
    if not STACKS_ROOT.exists():
        return []
    return sorted(
        p.name for p in STACKS_ROOT.iterdir() if p.is_dir() and (p / "compose.yml").exists()
    )


_stacks_root_host_path_cache: str | None = None


def _stacks_root_host_path() -> str:
    """Resolves DOCKER_STACKS_ROOT's real *host*-side path by inspecting
    this container's own bind mount, rather than assuming the documented
    default (/data/ops-center/docker-stacks) - DATA_ROOT is a
    .env-configurable value (see compose.yml), so guessing would silently
    show the wrong path for any install that overrides it. Falls back to
    the container-internal path if this container can't be found (e.g.
    running outside compose) - still useful, just not host-absolute."""
    global _stacks_root_host_path_cache
    if _stacks_root_host_path_cache is not None:
        return _stacks_root_host_path_cache
    resolved = str(STACKS_ROOT)
    try:
        self_container = _client().containers.get(socket_module.gethostname())
        for m in self_container.attrs.get("Mounts", []):
            if m.get("Destination") == str(STACKS_ROOT):
                resolved = m.get("Source", resolved)
                break
    except docker.errors.APIError:
        pass
    _stacks_root_host_path_cache = resolved
    return resolved


def get_stack(name: str) -> dict | None:
    stack_dir = _validate_stack_name(name)
    compose_path = stack_dir / "compose.yml"
    if not compose_path.exists():
        return None
    host_path = f"{_stacks_root_host_path()}/{name}/compose.yml"
    return {"compose_yaml": compose_path.read_text(), "path": host_path}


def deploy_stack(name: str, compose_yaml: str) -> dict:
    stack_dir = _validate_stack_name(name)
    stack_dir.mkdir(parents=True, exist_ok=True)
    compose_path = stack_dir / "compose.yml"
    compose_path.write_text(compose_yaml)

    result = subprocess.run(
        ["docker", "compose", "-p", name, "-f", str(compose_path), "up", "-d", "--remove-orphans"],
        capture_output=True,
        text=True,
        timeout=COMPOSE_TIMEOUT_SECONDS,
        check=False,
    )
    return {
        "ok": result.returncode == 0,
        "stdout": result.stdout[-8000:],
        "stderr": result.stderr[-8000:],
    }


def remove_stack(name: str) -> dict:
    stack_dir = _validate_stack_name(name)
    compose_path = stack_dir / "compose.yml"
    if not compose_path.exists():
        return {"ok": False, "stdout": "", "stderr": f"stack '{name}' not found"}

    result = subprocess.run(
        ["docker", "compose", "-p", name, "-f", str(compose_path), "down", "--volumes"],
        capture_output=True,
        text=True,
        timeout=COMPOSE_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode == 0:
        import shutil

        shutil.rmtree(stack_dir, ignore_errors=True)
    return {"ok": result.returncode == 0, "stdout": result.stdout[-8000:], "stderr": result.stderr[-8000:]}


_ALLOWED_STACK_ACTIONS = ("start", "stop", "restart", "pull")


def list_stack_containers(name: str) -> list[dict]:
    ids = _run_docker(["ps", "-aq", "--filter", f"label=com.docker.compose.project={name}"]).stdout.split()
    if not ids:
        return []
    result = _run_docker(["inspect", *ids])
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []


def list_all_containers_raw() -> list[dict]:
    """Every container on this host, inspected - used to discover
    docker-compose projects that exist on the host but weren't deployed
    through ops-center (Portainer, or by hand), by grouping on their
    com.docker.compose.project/service labels. Same two-call shape as
    list_stack_containers() above, just without the project filter - see
    backend/app/services/stack_discovery.py for the grouping/reconstruction
    that happens with this raw data (kept out of security-worker - this
    module's job stays "talk to docker.sock", not "understand compose")."""
    ids = _run_docker(["ps", "-aq"]).stdout.split()
    if not ids:
        return []
    result = _run_docker(["inspect", *ids])
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else []


def stack_action(name: str, action: str) -> dict:
    if action not in _ALLOWED_STACK_ACTIONS:
        raise ValueError(f"action must be one of {_ALLOWED_STACK_ACTIONS}, got {action!r}")
    stack_dir = _validate_stack_name(name)
    compose_path = stack_dir / "compose.yml"
    if not compose_path.exists():
        return {"ok": False, "stdout": "", "stderr": f"stack '{name}' not found"}

    result = subprocess.run(
        ["docker", "compose", "-p", name, "-f", str(compose_path), action],
        capture_output=True,
        text=True,
        timeout=COMPOSE_TIMEOUT_SECONDS,
        check=False,
    )
    return {"ok": result.returncode == 0, "stdout": result.stdout[-8000:], "stderr": result.stderr[-8000:]}


def pull_image(image: str, registry_url: str | None = None, username: str | None = None, password: str | None = None) -> dict:
    """Explicit, user-initiated only (see backend/app/api/routes/containers.py) - never called
    automatically. If registry credentials are given, logs in first via --password-stdin so the
    password never appears in argv/process listings (readable by anything else in this
    container's PID namespace) the way a -p/--password flag would."""
    if registry_url and username and password:
        login = subprocess.run(
            ["docker", "login", registry_url, "-u", username, "--password-stdin"],
            input=password,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if login.returncode != 0:
            return {"ok": False, "stdout": login.stdout[-4000:], "stderr": login.stderr[-4000:]}

    result = _run_docker(["pull", image], timeout=COMPOSE_TIMEOUT_SECONDS)
    return {"ok": result.returncode == 0, "stdout": result.stdout[-8000:], "stderr": result.stderr[-8000:]}


def _endpoint_config_for_recreate(net_attrs: dict) -> dict:
    """Strips a NetworkSettings.Networks entry (read-only fields like
    EndpointID/NetworkID/the live IP/MacAddress included) down to what's
    actually valid to send back in a create call's NetworkingConfig -
    static IPAMConfig and any real aliases, with the auto-generated
    short-container-ID alias filtered out since the new container gets
    its own anyway."""
    old_id_alias = re.compile(r"^[0-9a-f]{12}$")
    aliases = [a for a in (net_attrs.get("Aliases") or []) if a and not old_id_alias.match(a)]
    config: dict = {}
    if aliases:
        config["Aliases"] = aliases
    if net_attrs.get("IPAMConfig"):
        config["IPAMConfig"] = net_attrs["IPAMConfig"]
    return config


def recreate_container(name: str, image: str) -> dict:
    """Stops and removes `name`, then recreates it under the same name from
    the exact Config/HostConfig JSON docker itself recorded at inspect time
    (just swapping Image) rather than reinterpreting individual fields -
    the same verbatim-replay approach watchtower uses, so it round-trips
    correctly regardless of how the container was originally started
    (compose, `docker run`, Portainer...). Local-host only, same as every
    other function in this module. Caller is expected to have already
    pulled `image` (see pull_image above) - this never pulls itself."""
    client = _client()
    api = client.api
    try:
        attrs = api.inspect_container(name)
    except docker.errors.NotFound:
        return {"ok": False, "message": f"container '{name}' not found"}
    except docker.errors.APIError as exc:
        return {"ok": False, "message": str(exc)}

    config = dict(attrs.get("Config") or {})
    config["Image"] = image
    host_config = attrs.get("HostConfig") or {}
    networks = (attrs.get("NetworkSettings") or {}).get("Networks") or {}

    # The Docker API only accepts one network in a create call's
    # NetworkingConfig - the one matching HostConfig.NetworkMode gets
    # attached implicitly by create itself; anything beyond that has to be
    # connected afterwards via a separate call.
    network_names = list(networks.keys())
    primary_name = host_config.get("NetworkMode")
    if primary_name not in networks and network_names:
        primary_name = network_names[0]
    payload = {**config, "HostConfig": host_config}
    if primary_name in networks:
        payload["NetworkingConfig"] = {
            "EndpointsConfig": {primary_name: _endpoint_config_for_recreate(networks[primary_name])}
        }

    try:
        api.stop(name, timeout=10)
    except docker.errors.APIError:
        pass  # already stopped - fine, remove below still needs to happen
    try:
        api.remove_container(name)
    except docker.errors.APIError as exc:
        return {"ok": False, "message": f"stopped '{name}' but failed to remove it before recreating: {exc}"}

    try:
        created = api.create_container_from_config(payload, name=name)
    except docker.errors.APIError as exc:
        return {"ok": False, "message": f"'{name}' was removed but recreation failed - it no longer exists: {exc}"}

    container_id = created["Id"]
    for net_name in network_names:
        if net_name == primary_name:
            continue
        try:
            api.connect_container_to_network(container_id, net_name, **_endpoint_config_for_recreate(networks[net_name]))
        except docker.errors.APIError as exc:
            return {"ok": False, "message": f"created '{name}' but failed to attach network {net_name!r}: {exc}"}

    try:
        api.start(container_id)
    except docker.errors.APIError as exc:
        return {"ok": False, "message": f"created '{name}' but failed to start it: {exc}"}

    return {"ok": True, "message": f"recreated '{name}' with image {image}"}


_SHELL_CANDIDATES = ("/bin/bash", "/bin/sh", "/bin/ash")


def detect_shell(name: str) -> str:
    """Best-effort: tries each candidate in order via a quick non-interactive
    exec, falls back to the first candidate (whatever error it produces is
    at least a normal, readable one) if none of the probes succeed."""
    try:
        container = _client().containers.get(name)
    except docker.errors.NotFound:
        return _SHELL_CANDIDATES[0]
    for shell in _SHELL_CANDIDATES:
        try:
            result = container.exec_run(["test", "-x", shell])
            if result.exit_code == 0:
                return shell
        except docker.errors.APIError:
            continue
    return _SHELL_CANDIDATES[0]


_CONSOLE_SOCKET_RECV_TIMEOUT = 0.2


def run_exec_relay(session_id: str, name: str, shell: str) -> None:
    """
    Bridges a real interactive shell inside container `name` to two Redis
    pub/sub channels, console:{session_id}:in and :out. Runs in a plain
    background thread (started by security.tasks.start_exec_session, never
    a Celery task body itself - security-worker runs --concurrency=1, and a
    task occupying that slot for a whole interactive session would starve
    every other action). ops-api's WS route (no docker.sock access) is the
    other end of the bridge - see backend/app/api/routes/containers.py.

    docker-py's exec socket is a raw duplex stream once tty=True (no
    stdout/stderr multiplexing framing, unlike a non-tty exec) - reading
    and writing it directly is exactly what `docker exec -it` itself does
    under the hood.
    """
    in_channel = f"console:{session_id}:in"
    out_channel = f"console:{session_id}:out"
    r = get_redis_client()

    try:
        client = _client()
        container = client.containers.get(name)
        exec_id = client.api.exec_create(
            container.id, [shell], stdin=True, tty=True, stdout=True, stderr=True
        )["Id"]
        raw = client.api.exec_start(exec_id, socket=True, tty=True)
        sock = getattr(raw, "_sock", raw)
        sock.settimeout(_CONSOLE_SOCKET_RECV_TIMEOUT)
    except Exception as exc:
        r.publish(out_channel, f"\r\n[console] failed to start session: {exc}\r\n".encode())
        r.publish(out_channel, b"__CLOSED__")
        r.close()
        return

    stop = threading.Event()

    def _pump_out() -> None:
        while not stop.is_set():
            try:
                data = sock.recv(4096)
            except socket_module.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            try:
                r.publish(out_channel, data)
            except Exception:
                break
        stop.set()
        try:
            r.publish(out_channel, b"__CLOSED__")
        except Exception:
            pass

    reader = threading.Thread(target=_pump_out, name=f"console-relay-out-{session_id}", daemon=True)
    reader.start()

    pubsub = r.pubsub()
    pubsub.subscribe(in_channel)
    try:
        while not stop.is_set():
            message = pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                continue
            data = message["data"]
            if data == b"__CLOSE__":
                break
            try:
                sock.sendall(data)
            except OSError:
                break
    finally:
        stop.set()
        try:
            # Best-effort: closing our end of the exec socket does NOT kill
            # the remote process - a well-known Docker limitation (an exec
            # session outlives its client disconnecting, see
            # moby/moby#9098) - so a session left sitting idle at its
            # prompt would otherwise linger in the container forever.
            # Ctrl-C first in case something's mid-command, then exit the
            # shell. If the process already exited on its own (the socket
            # is already dead), this just raises OSError, caught below.
            sock.sendall(b"\x03\r\nexit\r\n")
        except OSError:
            pass
        try:
            sock.close()
        except Exception:
            pass
        pubsub.close()
        r.close()
