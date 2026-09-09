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
        return [await _patroni_node_status(client, host, port) for host in hosts]


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
    try:
        client = redis_lib.Redis(
            host=host, port=6379, password=password or None, socket_timeout=2, decode_responses=True
        )
        info = await client.info("replication")
        await client.aclose()
        return RedisNodeStatus(
            host=host, reachable=True, role=info.get("role"), connected_slaves=info.get("connected_slaves")
        )
    except Exception:
        return RedisNodeStatus(host=host, reachable=False)


async def _sentinel_view(host: str, master_name: str) -> SentinelView:
    try:
        client = redis_lib.Redis(host=host, port=26379, socket_timeout=2, decode_responses=True)
        # Sentinel speaks the Redis protocol on its own port - a raw client
        # can send it SENTINEL subcommands directly, no separate client needed.
        data = await client.execute_command("SENTINEL", "MASTER", master_name)
        await client.aclose()
        return SentinelView(host=host, reachable=True, master_host=data.get("ip"))
    except Exception:
        return SentinelView(host=host, reachable=False)


async def _get_redis_status() -> RedisStatusRead:
    settings = get_settings()
    redis_hosts = [h.strip() for h in settings.redis_nodes.split(",") if h.strip()]
    sentinel_hosts = [
        entry.strip().split(":")[0] for entry in settings.redis_sentinels.split(",") if entry.strip()
    ]
    nodes = [await _redis_node_status(h, settings.redis_password) for h in redis_hosts]
    sentinels = [await _sentinel_view(h, settings.redis_master_name) for h in sentinel_hosts]
    return RedisStatusRead(master_name=settings.redis_master_name, nodes=nodes, sentinels=sentinels)


@router.get("/cluster/status", response_model=ClusterStatusRead)
async def get_cluster_status() -> ClusterStatusRead:
    """
    No peer ops-api to fan this out to symmetrically yet (Phase 3's
    active/active app tier isn't built) - each Patroni node and each
    Redis/Sentinel node is queried directly instead.
    """
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

    body: dict = {"leader": leader.name}
    if payload.candidate:
        body["candidate"] = payload.candidate

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"http://{leader.host}:{settings.patroni_rest_port}/switchover",
            json=body,
            auth=(settings.patroni_restapi_username, settings.patroni_restapi_password),
        )

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Patroni switchover failed: {resp.text}")
    return SwitchoverResult(ok=True, message=resp.text or "switchover completed")
