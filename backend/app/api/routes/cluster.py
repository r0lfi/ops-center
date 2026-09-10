import asyncio

import httpx
import redis.asyncio as redis_lib
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import require_role
from app.core.config import get_settings
from app.schemas.cluster import (
    ClusterStatusRead,
    PatroniNodeStatus,
    PostgresStatusRead,
    RedisNodeStatus,
    RedisStatusRead,
    SentinelView,
    SwitchoverRequest,
    SwitchoverResult,
)

router = APIRouter()


async def _patroni_node_status(client: httpx.AsyncClient, host: str, port: int) -> PatroniNodeStatus:
    try:
        resp = await client.get(f"http://{host}:{port}/patroni")
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return PatroniNodeStatus(name=None, host=host, reachable=False)

    return PatroniNodeStatus(
        name=data.get("patroni", {}).get("name"),
        host=host,
        reachable=True,
        role=data.get("role"),
        state=data.get("state"),
        replication_state=data.get("replication_state"),
        timeline=data.get("timeline"),
        replicas=data.get("replication"),
    )


async def _all_patroni_statuses(hosts: list[str], port: int) -> list[PatroniNodeStatus]:
    async with httpx.AsyncClient(timeout=3.0) as client:
        return list(await asyncio.gather(*(_patroni_node_status(client, host, port) for host in hosts)))


async def _get_postgres_status() -> PostgresStatusRead:
    settings = get_settings()
    hosts = [h.strip() for h in settings.patroni_nodes.split(",") if h.strip()]
    nodes = await _all_patroni_statuses(hosts, settings.patroni_rest_port)
    leader = next((n for n in nodes if n.role == "primary"), None)
    return PostgresStatusRead(
        scope=settings.patroni_scope,
        vip=settings.postgres_vip,
        vip_holder=leader.name if leader else None,
        nodes=nodes,
    )


async def _redis_node_status(host: str, password: str) -> RedisNodeStatus:
    client = redis_lib.Redis(
        host=host, port=6379, password=password or None,
        socket_timeout=2, socket_connect_timeout=2, decode_responses=True,
    )
    try:
        info = await client.info("replication")
        return RedisNodeStatus(
            host=host, reachable=True, role=info.get("role"), connected_slaves=info.get("connected_slaves")
        )
    except (redis_lib.RedisError, OSError, ValueError):
        return RedisNodeStatus(host=host, reachable=False)
    finally:
        await client.aclose()


async def _sentinel_view(host: str, master_name: str, port: int = 26379) -> SentinelView:
    client = redis_lib.Redis(
        host=host, port=port, socket_timeout=2, socket_connect_timeout=2, decode_responses=True,
    )
    try:
        # This typed helper parses Redis's alternating key/value array.
        data = await client.sentinel_master(master_name)
        return SentinelView(host=f"{host}:{port}", reachable=True, master_host=data.get("ip"))
    except (redis_lib.RedisError, OSError, ValueError):
        return SentinelView(host=f"{host}:{port}", reachable=False)
    finally:
        await client.aclose()


async def _get_redis_status() -> RedisStatusRead:
    settings = get_settings()
    redis_hosts = [h.strip() for h in settings.redis_nodes.split(",") if h.strip()]
    sentinel_hosts = [
        entry.strip().rsplit(":", 1) for entry in settings.redis_sentinels.split(",") if entry.strip()
    ]
    nodes = await asyncio.gather(*(_redis_node_status(h, settings.redis_password) for h in redis_hosts))
    sentinels = await asyncio.gather(*(_sentinel_view(h, settings.redis_master_name, int(port)) for h, port in sentinel_hosts))
    return RedisStatusRead(master_name=settings.redis_master_name, nodes=nodes, sentinels=sentinels)


@router.get("/cluster/status", response_model=ClusterStatusRead)
async def get_cluster_status() -> ClusterStatusRead:
    """Read configured HA services directly from any application node."""
    return ClusterStatusRead(postgres=await _get_postgres_status(), redis=await _get_redis_status())


@router.post(
    "/cluster/postgres/switchover",
    response_model=SwitchoverResult,
    dependencies=[Depends(require_role("admin"))],
)
async def trigger_switchover(payload: SwitchoverRequest) -> SwitchoverResult:
    settings = get_settings()
    hosts = [h.strip() for h in settings.patroni_nodes.split(",") if h.strip()]
    nodes = await _all_patroni_statuses(hosts, settings.patroni_rest_port)
    leader = next((n for n in nodes if n.role == "primary" and n.reachable), None)
    if leader is None:
        raise HTTPException(status_code=503, detail="no reachable Patroni primary found")

    if not settings.patroni_restapi_password:
        raise HTTPException(status_code=503, detail="Patroni administration is not configured")
    if not leader.name:
        raise HTTPException(status_code=503, detail="Patroni primary has no member name")
    if payload.candidate and not any(
        n.name == payload.candidate and n.reachable and n.role == "replica" for n in nodes
    ):
        raise HTTPException(status_code=400, detail="candidate must be a reachable configured replica")

    body: dict = {"leader": leader.name}
    if payload.candidate:
        body["candidate"] = payload.candidate

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"http://{leader.host}:{settings.patroni_rest_port}/switchover",
                json=body,
                auth=(settings.patroni_restapi_username, settings.patroni_restapi_password),
            )
    except httpx.HTTPError:
        # A timeout is ambiguous: do not retry an administrative operation.
        raise HTTPException(status_code=502, detail="Patroni did not confirm the switchover; check cluster status before retrying") from None
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail="Patroni rejected the switchover; check cluster status")
    return SwitchoverResult(ok=True, message="Switchover accepted; refresh cluster status to verify the primary")
