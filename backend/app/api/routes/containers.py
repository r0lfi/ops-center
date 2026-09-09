import asyncio
import re
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path

import asyncssh
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.core.config import get_settings
from app.db.session import async_session_factory, get_db
from app.models.container import Container, DockerEvent, Registry, Stack
from app.models.host import Host
from app.models.job import AnsibleJob
from app.models.vulnerability import ContainerVulnerability, Vulnerability
from app.schemas.container import (
    BulkActionItemResult,
    BulkActionRequest,
    BulkActionResponse,
    ContainerActionResult,
    ContainerLogsRead,
    ContainerRead,
    ContainerStatsRead,
    DockerEventRead,
    DockerHostRead,
    ImageRead,
    ImageUpdateStatusRead,
    NetworkContainerRead,
    NetworkRead,
    StackActionResult,
    StackContainerRead,
    StackDeployRequest,
    StackRead,
    StackSummaryRead,
    VolumeRead,
)
from app.schemas.app_catalog import RenderTemplateResponse
from app.schemas.vulnerability import ContainerVulnerabilityRead
from app.services import registry_client, stack_discovery
from app.services.auth import decode_access_token, role_at_least
from app.services.celery_client import get_celery_client
from app.services.connectivity import _PinnedHostKeyClient, _resolve_secret
from app.services.host_ops import get_host_by_hostname as _get_docker_host_or_404
from app.services.host_ops import run_remote_query as _run_remote_query
from app.services.host_ops import send_and_wait as _send_and_wait
from app.services.redis_client import get_redis_client

router = APIRouter()

# The Console WS route lives on its own router, included in main.py without
# dependencies=_AUTH: that list is built from HTTP-only security schemes
# (HTTPBearer, which requires a Request) and blows up with a bare 500
# (TypeError: HTTPBearer.__call__() missing 1 required positional argument:
# 'request') the instant it's asked to resolve against a WebSocket scope,
# before the route body ever runs - discovered live, not assumed. Auth for
# this route is therefore fully manual inside the handler (see
# container_console below) rather than router-level.
ws_router = APIRouter()

_STACK_ACTIONS = ("start", "stop", "restart", "pull")

# ops-host's container actions run on security-worker - the one
# component with Docker socket access (see security/docker_control.py).
# These block briefly on the task result instead of returning "queued" and
# making the frontend poll, since they're expected to finish in seconds
# (stack deploy: up to a few minutes if it needs to pull images).
_ACTION_TIMEOUT = 30
_STACK_TIMEOUT = 240

_LOCAL_HOSTNAME = get_settings().ops_local_hostname
# This app's own compose project - never itself discoverable/adoptable as
# a "foreign" stack, on any host it happens to be running on.
_OPS_CENTER_PROJECT_NAME = "ops-center"
_CONTAINER_ACTIONS = ("start", "stop", "restart")
# A real Docker container name can't contain anything that would make this
# unsafe - enforced here too, defense in depth, before it ever reaches
# container-control.yml's `argv:` (which passes it as one literal argument
# regardless, no shell involved either way).
_DOCKER_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]+$")
_REMOTE_ACTION_POLL_TIMEOUT = 45


@router.get("/containers", response_model=list[ContainerRead])
async def list_containers(hostname: str | None = None, db: AsyncSession = Depends(get_db)) -> list[ContainerRead]:
    query = select(Container).order_by(Container.hostname, Container.name)
    if hostname is not None:
        query = query.where(Container.hostname == hostname)
    containers = (await db.execute(query)).scalars().all()

    counts = await db.execute(
        select(
            ContainerVulnerability.container_name,
            func.count(ContainerVulnerability.id),
        ).group_by(ContainerVulnerability.container_name)
    )
    count_by_name = dict(counts.all())

    critical_counts = await db.execute(
        select(ContainerVulnerability.container_name, func.count(ContainerVulnerability.id))
        .join(Vulnerability, Vulnerability.id == ContainerVulnerability.vulnerability_id)
        .where(Vulnerability.severity == "critical")
        .group_by(ContainerVulnerability.container_name)
    )
    critical_by_name = dict(critical_counts.all())

    return [
        ContainerRead(
            id=c.id,
            hostname=c.hostname,
            name=c.name,
            image=c.image,
            status=c.status,
            health=c.health,
            restart_count=c.restart_count,
            last_seen=c.last_seen,
            vulnerability_count=count_by_name.get(c.name, 0),
            critical_vulnerability_count=critical_by_name.get(c.name, 0),
        )
        for c in containers
    ]


async def _run_remote_container_action(
    db: AsyncSession, host: Host, name: str, action: str
) -> dict:
    """
    Remote-host equivalent of the local docker.sock path: submits
    container-control.yml over the same SSH connection already used for
    patching/monitoring/container-inventory, then polls the job to a
    terminal state so the frontend's Start/Stop/Restart buttons behave the
    same way (blocking, immediate result) regardless of which host a
    container is on.
    """
    job = AnsibleJob(
        playbook="container-control.yml",
        target_description=f"{action} {name} on {host.hostname}",
        extra_vars={"container_name": name, "container_action": action},
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook",
        args=[str(job.id), [str(host.id)], "container-control.yml", None, job.extra_vars],
    )

    job_id = job.id
    for _ in range(_REMOTE_ACTION_POLL_TIMEOUT):
        await asyncio.sleep(1)
        await db.refresh(job)
        if job.status in ("successful", "failed", "cancelled"):
            break
    else:
        return {
            "ok": False,
            "message": f"{action} is still running on {host.hostname} after {_REMOTE_ACTION_POLL_TIMEOUT}s - check Jobs for job {job_id}",
        }

    if job.status == "successful":
        return {"ok": True, "message": f"{action} succeeded on {host.hostname}"}
    return {
        "ok": False,
        "message": f"{action} failed on {host.hostname} - see Jobs (job {job_id}) for the SSH/docker output",
    }


async def _container_action(name: str, hostname: str, action: str, db: AsyncSession) -> dict:
    if not _DOCKER_NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="not a valid container name")

    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.container_action", [name, action], _ACTION_TIMEOUT)

    host = (await db.execute(select(Host).where(Host.hostname == hostname))).scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail=f"no managed host named {hostname!r}")
    return await _run_remote_container_action(db, host, name, action)


async def _docker_images(hostname: str, db: AsyncSession) -> list[dict]:
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.list_images", [], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-images.yml", {})
    return result.get("images", [])


async def _docker_networks(hostname: str, db: AsyncSession) -> list[dict]:
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.list_networks", [], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-networks.yml", {})
    return result.get("networks", [])


async def _docker_volumes(hostname: str, db: AsyncSession) -> list[dict]:
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.list_volumes", [], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-volumes.yml", {})
    return result.get("volumes", [])


async def _docker_container_logs(hostname: str, name: str, tail: int, db: AsyncSession) -> dict:
    if not _DOCKER_NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="not a valid container name")
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.container_logs", [name, tail], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    return await _run_remote_query(db, host, "docker-logs.yml", {"container_name": name, "tail_lines": tail})


async def _docker_container_stats(hostname: str, name: str, db: AsyncSession) -> dict:
    if not _DOCKER_NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="not a valid container name")
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.container_stats", [name], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    return await _run_remote_query(db, host, "docker-stats.yml", {"container_name": name})


async def _docker_container_inspect(hostname: str, name: str, db: AsyncSession) -> dict | None:
    if not _DOCKER_NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="not a valid container name")
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.inspect_container", [name], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-inspect.yml", {"container_name": name})
    return result.get("inspect")


async def _docker_stack_containers(hostname: str, name: str, db: AsyncSession) -> list[dict]:
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.list_stack_containers", [name], _ACTION_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-stack-ps.yml", {"stack_name": name})
    return result.get("containers", [])


async def _docker_stack_action(hostname: str, name: str, action: str, db: AsyncSession) -> dict:
    if action not in _STACK_ACTIONS:
        raise HTTPException(status_code=422, detail=f"action must be one of {_STACK_ACTIONS}")
    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait("security.tasks.stack_action", [name, action], _STACK_TIMEOUT)
    host = await _get_docker_host_or_404(db, hostname)
    return await _run_remote_query(
        db, host, "docker-stack-action.yml", {"stack_name": name, "stack_action": action}, poll_timeout=_STACK_TIMEOUT
    )


async def _upsert_stack_row(db: AsyncSession, hostname: str, name: str) -> None:
    stack = (
        await db.execute(select(Stack).where(Stack.hostname == hostname, Stack.name == name))
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if stack is None:
        db.add(Stack(hostname=hostname, name=name, last_deployed_at=now))
    else:
        stack.last_deployed_at = now
    await db.commit()


async def _docker_host_summary(db: AsyncSession, host: Host) -> DockerHostRead:
    status_counts = dict(
        (
            await db.execute(
                select(Container.status, func.count(Container.id))
                .where(Container.hostname == host.hostname)
                .group_by(Container.status)
            )
        ).all()
    )
    total = sum(status_counts.values())
    running = status_counts.get("running", 0)
    unhealthy = (
        await db.execute(
            select(func.count(Container.id)).where(
                Container.hostname == host.hostname, Container.health == "unhealthy"
            )
        )
    ).scalar_one()
    last_seen = (
        await db.execute(select(func.max(Container.last_seen)).where(Container.hostname == host.hostname))
    ).scalar_one()
    return DockerHostRead(
        hostname=host.hostname,
        ip_address=host.ip_address,
        environment=host.environment,
        container_count=total,
        running_count=running,
        stopped_count=total - running,
        unhealthy_count=unhealthy,
        last_seen=last_seen,
    )


async def _bulk_single_action(hostname: str, name: str, action: str) -> BulkActionItemResult:
    # Each concurrent call gets its own DB session - AsyncSession isn't
    # safe to share across concurrently-running coroutines (same pattern
    # hosts.py's _run_onboarding_in_background uses for the same reason).
    async with async_session_factory() as db:
        try:
            result = await _container_action(name, hostname, action, db)
            return BulkActionItemResult(name=name, ok=result.get("ok", False), message=result.get("message", ""))
        except HTTPException as exc:
            return BulkActionItemResult(name=name, ok=False, message=str(exc.detail))


@router.post(
    "/containers/{hostname}/{name}/start",
    response_model=ContainerActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def start_container(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await _container_action(name, hostname, "start", db)


@router.post(
    "/containers/{hostname}/{name}/stop",
    response_model=ContainerActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def stop_container(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await _container_action(name, hostname, "stop", db)


@router.post(
    "/containers/{hostname}/{name}/restart",
    response_model=ContainerActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def restart_container(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await _container_action(name, hostname, "restart", db)


async def _discover_unmanaged_projects(hostname: str, db: AsyncSession) -> dict[str, list[dict]]:
    """Groups every container on the host by its
    com.docker.compose.project label - see stack_discovery.py. Includes
    projects already known to Ops Center too (the caller filters those
    out) - this always reflects live reality, nothing is cached/persisted
    from this call."""
    if hostname == _LOCAL_HOSTNAME:
        raw = await _send_and_wait("security.tasks.discover_containers", [], _ACTION_TIMEOUT)
    else:
        host = await _get_docker_host_or_404(db, hostname)
        result = await _run_remote_query(db, host, "docker-discover-stacks.yml", {})
        raw = result.get("containers", [])
    projects = stack_discovery.group_by_project(raw)
    projects.pop(_OPS_CENTER_PROJECT_NAME, None)
    return projects


@router.get("/docker-hosts/{hostname}/stacks", response_model=list[StackSummaryRead])
async def list_stacks(hostname: str, db: AsyncSession = Depends(get_db)) -> list[StackSummaryRead]:
    if hostname == _LOCAL_HOSTNAME:
        names = await _send_and_wait("security.tasks.list_stacks", [], _ACTION_TIMEOUT)
    else:
        host = await _get_docker_host_or_404(db, hostname)
        result = await _run_remote_query(db, host, "docker-stack-list.yml", {})
        names = result.get("stacks", [])

    rows = (await db.execute(select(Stack).where(Stack.hostname == hostname))).scalars().all()
    known = {r.name: r for r in rows}
    for name in names:
        known.setdefault(name, Stack(hostname=hostname, name=name))

    summaries = []
    for stack in known.values():
        containers = await _docker_stack_containers(hostname, stack.name, db)
        running = sum(1 for c in containers if (c.get("State") or {}).get("Status") == "running")
        summaries.append(
            StackSummaryRead(
                id=stack.id or uuid.uuid4(),
                hostname=hostname,
                name=stack.name,
                source=stack.source or "web_editor",
                container_count=len(containers),
                running_count=running,
                created_at=stack.created_at or datetime.now(timezone.utc),
                updated_at=stack.updated_at or datetime.now(timezone.utc),
                last_deployed_at=stack.last_deployed_at,
                managed=True,
            )
        )

    discovered = await _discover_unmanaged_projects(hostname, db)
    for name, containers in discovered.items():
        if name in known:
            continue
        running = sum(1 for c in containers if (c.get("State", {}).get("Status")) == "running")
        summaries.append(
            StackSummaryRead(
                id=uuid.uuid4(),
                hostname=hostname,
                name=name,
                source="discovered",
                container_count=len(containers),
                running_count=running,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
                last_deployed_at=None,
                managed=False,
            )
        )
    return summaries


@router.get("/docker-hosts/{hostname}/stacks/{name}/adopt-preview", response_model=RenderTemplateResponse)
async def adopt_preview(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Reconstructs (never reads a file - see stack_discovery.py) an
    equivalent compose.yml for a discovered-but-unmanaged project, for the
    frontend's Adopt flow to preview/edit before deploying through the
    normal, unmodified stack-deploy route. Read-only - no DB/filesystem
    write happens here."""
    projects = await _discover_unmanaged_projects(hostname, db)
    containers = projects.get(name)
    if containers is None:
        raise HTTPException(
            status_code=404, detail=f"no discovered (unmanaged) stack named {name!r} on {hostname!r}"
        )
    compose_yaml = stack_discovery.reconstruct_compose(name, containers)
    return {"compose_yaml": compose_yaml, "suggested_name": name}


@router.get(
    "/docker-hosts/{hostname}/stacks/{name}",
    response_model=StackRead,
    dependencies=[Depends(require_role("admin"))],
)
async def get_stack(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    if hostname == _LOCAL_HOSTNAME:
        local_result = await _send_and_wait("security.tasks.get_stack", [name], _ACTION_TIMEOUT)
        compose_yaml = local_result.get("compose_yaml") if local_result else None
        path = local_result.get("path") if local_result else None
    else:
        host = await _get_docker_host_or_404(db, hostname)
        result = await _run_remote_query(db, host, "docker-stack-get.yml", {"stack_name": name})
        compose_yaml = result.get("compose_yaml")
        path = result.get("path")
    if compose_yaml is None:
        raise HTTPException(status_code=404, detail="stack not found")
    return {"name": name, "compose_yaml": compose_yaml, "path": path}


@router.get("/docker-hosts/{hostname}/stacks/{name}/containers", response_model=list[StackContainerRead])
async def get_stack_containers(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> list[StackContainerRead]:
    containers = await _docker_stack_containers(hostname, name, db)
    return [
        StackContainerRead(
            id=c.get("Id", "")[:12],
            name=(c.get("Name") or "").lstrip("/"),
            image=(c.get("Config") or {}).get("Image", ""),
            status=(c.get("State") or {}).get("Status", "unknown"),
            health=((c.get("State") or {}).get("Health") or {}).get("Status"),
        )
        for c in containers
    ]


@router.post(
    "/docker-hosts/{hostname}/stacks",
    response_model=StackActionResult,
    status_code=201,
    dependencies=[Depends(require_role("admin"))],
)
async def deploy_stack(hostname: str, payload: StackDeployRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """
    Deploys arbitrary docker-compose YAML. This is unrestricted container
    creation - bind mounts, privileged mode, host networking, anything the
    compose file asks for - and is treated as equivalent to root on the
    target host. Admin-only, and every call here is audit-logged (including
    the full compose YAML) by the existing AuditLogMiddleware. See
    docs/security.md.
    """
    if hostname == _LOCAL_HOSTNAME:
        result = await _send_and_wait(
            "security.tasks.deploy_stack", [payload.name, payload.compose_yaml], _STACK_TIMEOUT
        )
    else:
        host = await _get_docker_host_or_404(db, hostname)
        result = await _run_remote_query(
            db,
            host,
            "docker-stack-deploy.yml",
            {"stack_name": payload.name, "compose_yaml": payload.compose_yaml},
            poll_timeout=_STACK_TIMEOUT,
        )
    if result.get("ok"):
        await _upsert_stack_row(db, hostname, payload.name)
    return result


@router.delete(
    "/docker-hosts/{hostname}/stacks/{name}",
    response_model=StackActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def remove_stack(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    if hostname == _LOCAL_HOSTNAME:
        result = await _send_and_wait("security.tasks.remove_stack", [name], _STACK_TIMEOUT)
    else:
        host = await _get_docker_host_or_404(db, hostname)
        result = await _run_remote_query(
            db, host, "docker-stack-remove.yml", {"stack_name": name}, poll_timeout=_STACK_TIMEOUT
        )
    if result.get("ok"):
        stack = (
            await db.execute(select(Stack).where(Stack.hostname == hostname, Stack.name == name))
        ).scalar_one_or_none()
        if stack is not None:
            await db.delete(stack)
            await db.commit()
    return result


@router.post(
    "/docker-hosts/{hostname}/stacks/{name}/{action}",
    response_model=StackActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def run_stack_action(hostname: str, name: str, action: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await _docker_stack_action(hostname, name, action, db)


@router.get("/docker-hosts", response_model=list[DockerHostRead])
async def list_docker_hosts(db: AsyncSession = Depends(get_db)) -> list[DockerHostRead]:
    hosts = (
        await db.execute(select(Host).where(Host.is_docker_host.is_(True)).order_by(Host.hostname))
    ).scalars().all()
    return [await _docker_host_summary(db, h) for h in hosts]


@router.get("/docker-hosts/{hostname}", response_model=DockerHostRead)
async def get_docker_host(hostname: str, db: AsyncSession = Depends(get_db)) -> DockerHostRead:
    host = (
        await db.execute(select(Host).where(Host.hostname == hostname, Host.is_docker_host.is_(True)))
    ).scalar_one_or_none()
    if host is None:
        raise HTTPException(status_code=404, detail=f"no Docker host named {hostname!r}")
    return await _docker_host_summary(db, host)


@router.get("/docker-hosts/{hostname}/images", response_model=list[ImageRead])
async def list_docker_images(hostname: str, db: AsyncSession = Depends(get_db)) -> list[ImageRead]:
    raw = await _docker_images(hostname, db)

    # Cross-reference against the already-synced containers table to count
    # how many containers on this host use each image tag - cheap DB-only
    # lookup, no extra Docker call needed for something we already track.
    counts_by_tag = dict(
        (
            await db.execute(
                select(Container.image, func.count(Container.id))
                .where(Container.hostname == hostname)
                .group_by(Container.image)
            )
        ).all()
    )

    images = []
    for img in raw:
        repo_tags = img.get("RepoTags") or []
        images.append(
            ImageRead(
                id=img.get("Id", ""),
                repo_tags=repo_tags,
                repo_digests=img.get("RepoDigests") or [],
                created=img.get("Created"),
                size_bytes=img.get("Size", 0),
                container_count=sum(counts_by_tag.get(tag, 0) for tag in repo_tags),
            )
        )
    return images


@router.get("/docker-hosts/{hostname}/networks", response_model=list[NetworkRead])
async def list_docker_networks(hostname: str, db: AsyncSession = Depends(get_db)) -> list[NetworkRead]:
    raw = await _docker_networks(hostname, db)
    networks = []
    for net in raw:
        ipam_configs = (net.get("IPAM") or {}).get("Config") or []
        first_config = ipam_configs[0] if ipam_configs else {}
        networks.append(
            NetworkRead(
                id=net.get("Id", ""),
                name=net.get("Name", ""),
                driver=net.get("Driver", ""),
                scope=net.get("Scope", ""),
                subnet=first_config.get("Subnet"),
                gateway=first_config.get("Gateway"),
                containers=[
                    NetworkContainerRead(
                        name=c.get("Name", ""),
                        ipv4_address=c.get("IPv4Address") or None,
                        ipv6_address=c.get("IPv6Address") or None,
                        mac_address=c.get("MacAddress") or None,
                    )
                    for c in (net.get("Containers") or {}).values()
                ],
            )
        )
    return networks


@router.get("/docker-hosts/{hostname}/volumes", response_model=list[VolumeRead])
async def list_docker_volumes(hostname: str, db: AsyncSession = Depends(get_db)) -> list[VolumeRead]:
    raw = await _docker_volumes(hostname, db)
    return [
        VolumeRead(
            name=v.get("Name", ""),
            driver=v.get("Driver", ""),
            mountpoint=v.get("Mountpoint", ""),
            created=v.get("CreatedAt"),
        )
        for v in raw
    ]


@router.get("/docker-hosts/{hostname}/events", response_model=list[DockerEventRead])
async def list_docker_events(
    hostname: str, event_type: str | None = None, limit: int = 200, db: AsyncSession = Depends(get_db)
) -> list[DockerEventRead]:
    limit = max(1, min(limit, 1000))

    if hostname == _LOCAL_HOSTNAME:
        # Continuously collected by a background thread in security-worker
        # (see security/events.py) - this is a plain DB read, no Celery/
        # Ansible round trip needed.
        query = select(DockerEvent).where(DockerEvent.hostname == hostname)
        if event_type is not None:
            query = query.where(DockerEvent.event_type == event_type)
        query = query.order_by(DockerEvent.occurred_at.desc()).limit(limit)
        rows = (await db.execute(query)).scalars().all()
        return [
            DockerEventRead(
                hostname=r.hostname,
                event_type=r.event_type,
                action=r.action,
                actor_id=r.actor_id,
                actor_attributes=r.actor_attributes,
                occurred_at=r.occurred_at,
            )
            for r in rows
        ]

    # Remote hosts have no persistent channel to stream from (same
    # constraint Logs/Stats hit in Phase 1) - bounded one-shot window
    # instead, never persisted.
    host = await _get_docker_host_or_404(db, hostname)
    result = await _run_remote_query(db, host, "docker-events.yml", {"since": "1h"})
    events = []
    for raw in result.get("events", []):
        actor = raw.get("Actor") or {}
        time_value = raw.get("time")
        occurred_at = (
            datetime.fromtimestamp(time_value, tz=timezone.utc) if time_value else datetime.now(timezone.utc)
        )
        events.append(
            DockerEventRead(
                hostname=hostname,
                event_type=raw.get("Type") or "unknown",
                action=raw.get("Action") or raw.get("status") or "unknown",
                actor_id=actor.get("ID") or raw.get("id"),
                actor_attributes=actor.get("Attributes") or {},
                occurred_at=occurred_at,
            )
        )
    if event_type is not None:
        events = [e for e in events if e.event_type == event_type]
    events.sort(key=lambda e: e.occurred_at, reverse=True)
    return events[:limit]


@router.get("/containers/{hostname}/{name}/inspect")
async def inspect_container_route(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> dict:
    data = await _docker_container_inspect(hostname, name, db)
    if data is None:
        raise HTTPException(status_code=404, detail=f"container {name!r} not found on {hostname!r}")
    return data


@router.get("/containers/{hostname}/{name}/logs", response_model=ContainerLogsRead)
async def container_logs_route(
    hostname: str, name: str, tail: int = 200, db: AsyncSession = Depends(get_db)
) -> ContainerLogsRead:
    tail = max(1, min(tail, 5000))
    result = await _docker_container_logs(hostname, name, tail, db)
    return ContainerLogsRead(lines=result.get("lines", []), ok=result.get("ok", True))


@router.get("/containers/{hostname}/{name}/stats", response_model=ContainerStatsRead)
async def container_stats_route(
    hostname: str, name: str, db: AsyncSession = Depends(get_db)
) -> ContainerStatsRead:
    raw = await _docker_container_stats(hostname, name, db)
    return ContainerStatsRead(
        cpu_percent=raw.get("CPUPerc"),
        mem_usage=raw.get("MemUsage"),
        mem_percent=raw.get("MemPerc"),
        net_io=raw.get("NetIO"),
        block_io=raw.get("BlockIO"),
        pids=raw.get("PIDs"),
    )


@router.post(
    "/containers/{hostname}/bulk-action",
    response_model=BulkActionResponse,
    dependencies=[Depends(require_role("admin"))],
)
async def bulk_container_action(hostname: str, payload: BulkActionRequest) -> BulkActionResponse:
    if payload.action not in _CONTAINER_ACTIONS:
        raise HTTPException(status_code=422, detail=f"action must be one of {_CONTAINER_ACTIONS}")
    items = await asyncio.gather(
        *(_bulk_single_action(hostname, name, payload.action) for name in payload.names)
    )
    return BulkActionResponse(results=list(items))


async def _resolve_registry_credentials(db: AsyncSession, image: str) -> tuple[Registry | None, str | None]:
    """Matches an image reference to a configured Registry by hostname (if
    any) and reads its secret from disk - never returns the secret_path
    itself further than this function, and never persists it anywhere."""
    registry_host, _, _ = registry_client.parse_image_ref(image)
    registries = (await db.execute(select(Registry))).scalars().all()
    matching = next(
        (r for r in registries if r.url.rstrip("/") in (registry_host, f"https://{registry_host}")), None
    )
    password = None
    if matching and matching.secret_path:
        secrets_root = Path(get_settings().secrets_root).resolve()
        secret_file = (secrets_root / matching.secret_path).resolve()
        if secret_file.exists():
            password = secret_file.read_text().strip()
    return matching, password


@router.get("/images/update-status", response_model=ImageUpdateStatusRead)
async def image_update_status(
    image: str, local_digest: str | None = None, db: AsyncSession = Depends(get_db)
) -> ImageUpdateStatusRead:
    """Registry-side check only - never touches any host. image is a full
    reference (e.g. "ghcr.io/home-assistant/home-assistant:2026.3.4");
    local_digest is one of that image's RepoDigests (already known to the
    caller from GET .../images), the sha256:... portion. On-demand only,
    short TTL-cached in registry_client - never a scheduled poll, see that
    module's docstring for why."""
    matching, password = await _resolve_registry_credentials(db, image)
    latest_digest, detail = await registry_client.get_latest_digest(
        image, matching.username if matching else None, password
    )

    if latest_digest is None:
        return ImageUpdateStatusRead(status="unknown", local_digest=local_digest, detail=detail)
    if not local_digest:
        return ImageUpdateStatusRead(
            status="unknown",
            latest_digest=latest_digest,
            detail="no local digest recorded for this image (built locally, or never pulled with content trust)",
        )
    # local_digest may be a bare "sha256:..." or a full "repo@sha256:..."
    # RepoDigests entry (frontend is expected to pass the bare form, but
    # this is cheap to accept defensively either way).
    local_hash = local_digest.rsplit("@", 1)[-1]
    status = "up_to_date" if local_hash == latest_digest else "update_available"
    return ImageUpdateStatusRead(status=status, local_digest=local_digest, latest_digest=latest_digest)


@router.post(
    "/docker-hosts/{hostname}/images/pull",
    response_model=StackActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def pull_image_route(hostname: str, image: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Explicit, user-initiated only - never called automatically. If a
    configured Registry's URL matches this image's registry host, logs in
    with its credentials first; otherwise pulls anonymously."""
    matching, password = await _resolve_registry_credentials(db, image)
    registry_url = matching.url if matching else None
    username = matching.username if matching else None

    if hostname == _LOCAL_HOSTNAME:
        return await _send_and_wait(
            "security.tasks.pull_image", [image, registry_url, username, password], _STACK_TIMEOUT
        )
    host = await _get_docker_host_or_404(db, hostname)
    return await _run_remote_query(
        db,
        host,
        "docker-pull-image.yml",
        {"image": image, "registry_url": registry_url or "", "registry_username": username or "", "registry_password": password or ""},
        poll_timeout=_STACK_TIMEOUT,
    )


@router.post(
    "/containers/{hostname}/{name}/recreate",
    response_model=ContainerActionResult,
    dependencies=[Depends(require_role("admin"))],
)
async def recreate_container_route(hostname: str, name: str, image: str) -> dict:
    """Stops/removes `name` and recreates it under the same name from its
    own current Config/HostConfig/network attachments, just swapping in
    `image` - see security/docker_control.py's recreate_container for how.
    Callers are expected to have already pulled `image` (the frontend does
    pull, then this, as two separate confirmed steps) - this never pulls.

    Local-host only for now: doing this safely on a remote host needs the
    same raw-JSON-replay approach reimplemented without docker-py (no
    Ansible playbook for it exists yet), so it's refused explicitly here
    rather than silently doing something less correct."""
    if not _DOCKER_NAME_RE.match(name):
        raise HTTPException(status_code=422, detail="not a valid container name")
    if hostname != _LOCAL_HOSTNAME:
        raise HTTPException(
            status_code=501,
            detail=f"recreate isn't supported on remote hosts yet - only {_LOCAL_HOSTNAME}",
        )
    return await _send_and_wait("security.tasks.recreate_container", [name, image], _STACK_TIMEOUT)


@router.get("/containers/{hostname}/{name}/vulnerabilities", response_model=list[ContainerVulnerabilityRead])
async def container_vulnerabilities(hostname: str, name: str, db: AsyncSession = Depends(get_db)) -> list[ContainerVulnerabilityRead]:
    # Note: still name-only, not host-scoped, like ContainerVulnerability
    # itself (a pre-existing limitation - a same-named container on two
    # different hosts would collide here, unchanged by this endpoint).
    del hostname
    rows = (
        await db.execute(
            select(ContainerVulnerability, Vulnerability)
            .join(Vulnerability, Vulnerability.id == ContainerVulnerability.vulnerability_id)
            .where(ContainerVulnerability.container_name == name)
            .order_by(Vulnerability.severity, Vulnerability.cve_id)
        )
    ).all()
    return [
        ContainerVulnerabilityRead(
            cve_id=v.cve_id,
            severity=v.severity,
            cvss_score=v.cvss_score,
            package_name=v.package_name,
            installed_version=cv.installed_version,
            fixed_version=v.fixed_version,
            fix_available=v.fix_available,
            description=v.description,
        )
        for cv, v in rows
    ]


_CONSOLE_SSH_TIMEOUT = 10


async def _run_local_console(websocket: WebSocket, name: str, shell: str) -> None:
    """
    Bridges the browser WS to security-worker's docker.sock-backed exec
    session (ops-api itself has no socket access) over two Redis pub/sub
    channels - see security/docker_control.py's run_exec_relay for the
    other end. The relay is dispatched fire-and-forget (never awaited via
    _send_and_wait, which would block on Celery's result backend for
    something that intentionally never returns).
    """
    resolved_shell = shell or await _send_and_wait("security.tasks.detect_shell", [name], _ACTION_TIMEOUT)
    session_id = str(uuid.uuid4())
    in_channel = f"console:{session_id}:in"
    out_channel = f"console:{session_id}:out"

    get_celery_client().send_task(
        "security.tasks.start_exec_session",
        args=[session_id, name, resolved_shell],
        queue=f"security.{_LOCAL_HOSTNAME}",
    )

    redis_client = get_redis_client()
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(out_channel)

    async def _pump_out() -> None:
        try:
            while True:
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message is None:
                    continue
                data = message["data"]
                if data == b"__CLOSED__":
                    await websocket.close(code=1000)
                    return
                text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
                await websocket.send_text(text)
        except Exception:
            pass

    reader_task = asyncio.create_task(_pump_out())
    try:
        while True:
            text = await websocket.receive_text()
            await redis_client.publish(in_channel, text.encode())
    except WebSocketDisconnect:
        pass
    finally:
        reader_task.cancel()
        try:
            await redis_client.publish(in_channel, b"__CLOSE__")
        except Exception:
            pass
        await pubsub.unsubscribe(out_channel)
        await pubsub.aclose()
        await redis_client.aclose()


async def _run_remote_console(websocket: WebSocket, host: Host, name: str, shell: str) -> None:
    """
    Ansible has no interactive-PTY primitive, so this bypasses it entirely:
    a direct asyncssh connection from ops-api straight to the target host,
    reusing connectivity.py's credential-resolution and host-key-pinning
    exactly as check_ssh() does, then a PTY `docker exec -it` over it.
    Key-only - a password credential can't be handed to a non-interactive
    PTY setup the way check_ssh's client_keys=[] path does, so this is
    refused with a clear error instead of silently failing.
    """
    credential = host.credential
    if credential is None or credential.credential_type != "ssh_key":
        await websocket.send_text("\r\n[console] this host needs an SSH key credential for Console access\r\n")
        await websocket.close(code=4409)
        return

    try:
        secret_file = _resolve_secret(credential.secret_path)
        client_key = asyncssh.import_private_key(secret_file.read_text())
    except (ValueError, OSError, asyncssh.Error) as exc:
        await websocket.send_text(f"\r\n[console] could not load SSH credential: {exc}\r\n")
        await websocket.close(code=1011)
        return

    resolved_shell = shell or "/bin/sh"
    remote_command = f"docker exec -it {shlex.quote(name)} {shlex.quote(resolved_shell)}"

    def _client_factory() -> _PinnedHostKeyClient:
        return _PinnedHostKeyClient(host.ssh_host_fingerprint)

    try:
        async with asyncssh.connect(
            host=host.ip_address,
            port=host.ssh_port,
            username=host.ssh_user,
            known_hosts=None,
            client_factory=_client_factory,
            client_keys=[client_key],
            connect_timeout=_CONSOLE_SSH_TIMEOUT,
        ) as conn:
            process = await conn.create_process(remote_command, term_type="xterm-256color", encoding=None)
            try:

                async def _pump_out() -> None:
                    try:
                        while True:
                            data = await process.stdout.read(4096)
                            if not data:
                                break
                            await websocket.send_text(data.decode("utf-8", errors="replace"))
                    except Exception:
                        pass

                reader_task = asyncio.create_task(_pump_out())
                try:
                    while True:
                        text = await websocket.receive_text()
                        process.stdin.write(text.encode())
                except WebSocketDisconnect:
                    pass
                finally:
                    reader_task.cancel()
            finally:
                # process.terminate() sends an SSH "signal" channel
                # request, which most sshd servers simply ignore for exec
                # channels - and even where honored, it would only reach
                # the remote `docker exec` CLI, not necessarily the
                # containerized process itself (the same
                # outlives-its-client Docker limitation as the local path
                # - see docker_control.run_exec_relay's cleanup). Same
                # best-effort nudge here instead.
                try:
                    process.stdin.write(b"\x03\r\nexit\r\n")
                    await asyncio.sleep(0.3)  # give the write time to flush before the channel closes
                except Exception:
                    pass
                process.close()
    except (OSError, asyncssh.Error) as exc:
        try:
            await websocket.send_text(f"\r\n[console] SSH connection failed: {exc}\r\n")
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@ws_router.websocket("/containers/{hostname}/{name}/console")
async def container_console(websocket: WebSocket, hostname: str, name: str, shell: str = "") -> None:
    """
    Auth here is manual, not the router's dependencies=_AUTH (main.py) -
    that only ever applies to HTTP path operations, never a WebSocketRoute,
    and even if it did, the bearer token can't travel as a header anyway
    (the browser's native WebSocket API can't set one) - it's a query
    param instead, validated by hand with the same decode_access_token
    every HTTP route ultimately relies on. Admin-only: a shell inside a
    container is strictly more powerful than start/stop/restart, which are
    already admin-gated.
    """
    token = websocket.query_params.get("token")
    payload = decode_access_token(token) if token else None
    if payload is None:
        await websocket.close(code=4401)
        return
    if not role_at_least(payload.get("role", ""), "admin"):
        await websocket.close(code=4403)
        return
    if not _DOCKER_NAME_RE.match(name):
        await websocket.close(code=4404)
        return

    await websocket.accept()

    if hostname == _LOCAL_HOSTNAME:
        await _run_local_console(websocket, name, shell)
        return

    async with async_session_factory() as db:
        host = (
            await db.execute(
                select(Host).where(Host.hostname == hostname).options(selectinload(Host.credential))
            )
        ).scalar_one_or_none()
    if host is None:
        await websocket.close(code=4404)
        return
    await _run_remote_console(websocket, host, name, shell)
