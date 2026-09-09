import json
import os
import subprocess
import tempfile
import threading
from datetime import datetime, timezone

import docker
from sqlalchemy import select

from app.models.container import Container
from app.models.host import Host
from app.models.vulnerability import ContainerVulnerability, HostVulnerability
from security import docker_control
from security.celery_app import celery_app
from security.db import SessionLocal
from security.feeds import refresh_almalinux_errata, refresh_cisa_kev, refresh_first_epss
from security.trivy_parser import iter_findings, upsert_vulnerability

TRIVY_SERVER = os.environ.get("TRIVY_SERVER", "http://trivy-server:4954")
TRIVY_TIMEOUT_SECONDS = 300

# Module-level singleton, same pattern as security/db.py's engine: this
# wraps a requests.Session-backed connection to docker.sock. Building a
# fresh docker.from_env() per call and never closing it (the previous
# behavior) leaked a socket connection every run - sync_container_status
# alone runs every ~2 minutes, so ~720 leaked clients/day.
_docker_client: docker.DockerClient | None = None


def _docker() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _run_trivy(args: list[str]) -> dict | None:
    try:
        result = subprocess.run(
            ["trivy", *args, "--server", TRIVY_SERVER, "--format", "json", "--quiet"],
            capture_output=True,
            text=True,
            timeout=TRIVY_TIMEOUT_SECONDS,
            check=False,
        )
        if result.returncode not in (0, 1):  # trivy uses 1 for "vulnerabilities found" with --exit-code set; we don't set it, so 0 is the norm
            return None
        return json.loads(result.stdout) if result.stdout.strip() else None
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return None


def _build_cyclonedx_sbom(packages: list[dict], distro: str) -> dict:
    components = [
        {
            "type": "library",
            "name": pkg["name"],
            "version": pkg.get("version", ""),
            "purl": f"pkg:rpm/{pkg['name']}@{pkg.get('version', '')}" if pkg.get("arch") else None,
        }
        for pkg in packages
        if pkg.get("name")
    ]
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "metadata": {"component": {"type": "operating-system", "name": distro or "linux"}},
        "components": components,
    }


@celery_app.task(name="security.tasks.scan_host_sbom")
def scan_host_sbom(host_id: str, distro: str, packages: list[dict]) -> None:
    db = SessionLocal()
    try:
        host = db.get(Host, host_id)
        if host is None:
            return

        sbom = _build_cyclonedx_sbom(packages, distro)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(sbom, f)
            sbom_path = f.name

        try:
            report = _run_trivy(["sbom", sbom_path])
        finally:
            os_remove_quiet(sbom_path)

        if report is None:
            return  # trivy-server unreachable or scan failed - leave prior results in place, don't wipe them

        seen_vuln_ids = set()
        for finding in iter_findings(report):
            vuln = upsert_vulnerability(db, finding)
            seen_vuln_ids.add(vuln.id)

            link = db.execute(
                select(HostVulnerability).where(
                    HostVulnerability.host_id == host.id, HostVulnerability.vulnerability_id == vuln.id
                )
            ).scalar_one_or_none()
            if link is None:
                db.add(
                    HostVulnerability(
                        host_id=host.id, vulnerability_id=vuln.id, installed_version=finding.get("InstalledVersion")
                    )
                )
            else:
                link.last_seen = _now()
                link.installed_version = finding.get("InstalledVersion")
        db.commit()
    finally:
        db.close()


@celery_app.task(name="security.tasks.scan_local_images")
def scan_local_images() -> None:
    """Nightly: scans the image behind every currently-running local
    container on this docker host."""
    db = SessionLocal()
    try:
        client = _docker()
        containers = client.containers.list()

        for container in containers:
            image_tags = container.image.tags
            image_ref = image_tags[0] if image_tags else container.image.id

            report = _run_trivy(["image", image_ref])
            if report is None:
                continue

            for finding in iter_findings(report):
                vuln = upsert_vulnerability(db, finding)
                link = db.execute(
                    select(ContainerVulnerability).where(
                        ContainerVulnerability.container_name == container.name,
                        ContainerVulnerability.vulnerability_id == vuln.id,
                    )
                ).scalar_one_or_none()
                if link is None:
                    db.add(
                        ContainerVulnerability(
                            container_name=container.name,
                            image=image_ref,
                            vulnerability_id=vuln.id,
                            installed_version=finding.get("InstalledVersion"),
                        )
                    )
                else:
                    link.last_seen = _now()
            db.commit()
    finally:
        db.close()


def os_remove_quiet(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


from app.core.config import get_settings

LOCAL_HOSTNAME = get_settings().ops_local_hostname


@celery_app.task(name="security.tasks.sync_container_status")
def sync_container_status() -> None:
    """Every ~2 minutes: refresh ops-host's own containers table rows
    (name, image, status, health, restart count) for the Containers page.
    Uses the same Docker socket access as the vulnerability scan tasks -
    no new isolation boundary needed. Every other managed host is synced
    separately, over SSH via ansible/playbooks/container-inventory.yml -
    see worker.tasks._store_container_inventory - scoped to `hostname`
    here so the two paths never touch each other's rows."""
    db = SessionLocal()
    try:
        client = _docker()
        seen_names = set()
        for c in client.containers.list(all=True):
            try:
                c.reload()
                # c.image.tags does its own docker.sock lookup of the image
                # ID recorded in this container's own attrs at create time -
                # that ID can go stale (an image rebuilt/replaced since,
                # e.g. after a `docker compose build` this container's own
                # image tag wasn't recreated against yet) and raise
                # ImageNotFound. One container's stale image reference must
                # never take down every other container's last_seen update
                # for the rest of this cycle - hit exactly this live
                # (ops-center-scheduler, twice in one afternoon after
                # ops-worker rebuilds it wasn't recreated alongside).
                image_tags = c.image.tags
                image_ref = image_tags[0] if image_tags else (c.image.id or "unknown")
            except docker.errors.APIError:
                image_ref = c.attrs.get("Image", "unknown")
            state = c.attrs.get("State", {})
            health = (state.get("Health") or {}).get("Status")
            restart_count = c.attrs.get("RestartCount", 0)
            seen_names.add(c.name)

            row = db.execute(
                select(Container).where(Container.hostname == LOCAL_HOSTNAME, Container.name == c.name)
            ).scalar_one_or_none()
            if row is None:
                row = Container(hostname=LOCAL_HOSTNAME, name=c.name)
                db.add(row)
            row.image = image_ref
            row.status = c.status
            row.health = health
            row.restart_count = restart_count
            row.last_seen = _now()
        # Containers removed since the last sync shouldn't linger forever.
        if seen_names:
            stale = db.execute(
                select(Container).where(
                    Container.hostname == LOCAL_HOSTNAME, Container.name.not_in(seen_names)
                )
            ).scalars().all()
            for row in stale:
                db.delete(row)
        db.commit()
    finally:
        db.close()


@celery_app.task(name="security.tasks.refresh_security_feeds")
def refresh_security_feeds() -> None:
    """Hourly. Each source is independent and failure-isolated - see
    security/feeds.py."""
    db = SessionLocal()
    try:
        refresh_cisa_kev(db)
        refresh_first_epss(db)
        refresh_almalinux_errata(db)
    finally:
        db.close()


@celery_app.task(name="security.tasks.container_action")
def container_action(name: str, action: str) -> dict:
    if action not in ("start", "stop", "restart"):
        return {"ok": False, "message": f"unsupported action: {action}"}
    return docker_control.container_action(name, action)


@celery_app.task(name="security.tasks.container_exec")
def container_exec(name: str, command: str) -> dict:
    return docker_control.container_exec(name, command)


@celery_app.task(name="security.tasks.list_stacks")
def list_stacks() -> list[str]:
    return docker_control.list_stacks()


@celery_app.task(name="security.tasks.get_stack")
def get_stack(name: str) -> str | None:
    return docker_control.get_stack(name)


@celery_app.task(name="security.tasks.deploy_stack")
def deploy_stack(name: str, compose_yaml: str) -> dict:
    return docker_control.deploy_stack(name, compose_yaml)


@celery_app.task(name="security.tasks.remove_stack")
def remove_stack(name: str) -> dict:
    return docker_control.remove_stack(name)


@celery_app.task(name="security.tasks.list_images")
def list_images() -> list[dict]:
    return docker_control.list_images()


@celery_app.task(name="security.tasks.list_networks")
def list_networks() -> list[dict]:
    return docker_control.list_networks()


@celery_app.task(name="security.tasks.list_volumes")
def list_volumes() -> list[dict]:
    return docker_control.list_volumes()


@celery_app.task(name="security.tasks.container_logs")
def container_logs(name: str, tail: int) -> dict:
    return docker_control.container_logs(name, tail)


@celery_app.task(name="security.tasks.container_stats")
def container_stats(name: str) -> dict:
    return docker_control.container_stats(name)


@celery_app.task(name="security.tasks.inspect_container")
def inspect_container(name: str) -> dict | None:
    return docker_control.inspect_container(name)


@celery_app.task(name="security.tasks.list_stack_containers")
def list_stack_containers(name: str) -> list[dict]:
    return docker_control.list_stack_containers(name)


@celery_app.task(name="security.tasks.discover_containers")
def discover_containers() -> list[dict]:
    return docker_control.list_all_containers_raw()


@celery_app.task(name="security.tasks.stack_action")
def stack_action(name: str, action: str) -> dict:
    return docker_control.stack_action(name, action)


@celery_app.task(name="security.tasks.pull_image")
def pull_image(
    image: str, registry_url: str | None = None, username: str | None = None, password: str | None = None
) -> dict:
    return docker_control.pull_image(image, registry_url, username, password)


@celery_app.task(name="security.tasks.recreate_container")
def recreate_container(name: str, image: str) -> dict:
    return docker_control.recreate_container(name, image)


@celery_app.task(name="security.tasks.detect_shell")
def detect_shell(name: str) -> str:
    return docker_control.detect_shell(name)


@celery_app.task(name="security.tasks.start_exec_session")
def start_exec_session(session_id: str, name: str, shell: str) -> None:
    """Fire-and-forget: spawns the actual relay in a background thread and
    returns immediately, freeing this Celery slot right away - see
    docker_control.run_exec_relay's docstring for why this can never be the
    task body itself."""
    threading.Thread(
        target=docker_control.run_exec_relay,
        args=(session_id, name, shell),
        name=f"console-relay-{session_id}",
        daemon=True,
    ).start()
