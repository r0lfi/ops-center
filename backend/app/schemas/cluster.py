from pydantic import BaseModel


class PatroniNodeStatus(BaseModel):
    name: str | None
    host: str
    reachable: bool
    role: str | None = None  # "primary" | "replica", per Patroni's own /patroni role field
    state: str | None = None  # Patroni state: "running", "streaming", "stopped", ...
    replication_state: str | None = None  # replica-side: "streaming" once caught up to the primary
    timeline: int | None = None
    # Only populated when this node is the primary - Patroni's own view of each
    # connected replica (name/state/sync_state), avoids us re-deriving lag.
    replicas: list[dict] | None = None


class PostgresStatusRead(BaseModel):
    scope: str
    vip: str
    vip_holder: str | None  # name of the node currently holding the VIP, inferred from Patroni's primary election (the vrrp_script ties the two together by construction)
    nodes: list[PatroniNodeStatus]


class RedisNodeStatus(BaseModel):
    host: str
    reachable: bool
    role: str | None = None  # "master" | "slave", per Redis's own INFO replication
    connected_slaves: int | None = None  # only meaningful on the master


class SentinelView(BaseModel):
    host: str
    reachable: bool
    master_host: str | None = None  # which host this Sentinel currently believes is master


class RedisStatusRead(BaseModel):
    master_name: str
    nodes: list[RedisNodeStatus]
    sentinels: list[SentinelView]


class ClusterStatusRead(BaseModel):
    postgres: PostgresStatusRead
    redis: RedisStatusRead


class SwitchoverRequest(BaseModel):
    candidate: str | None = None


class SwitchoverResult(BaseModel):
    ok: bool
    message: str
