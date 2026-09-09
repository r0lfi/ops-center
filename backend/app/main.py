from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.api.deps import get_current_user
from app.api.routes import (
    ai,
    ai_memory,
    alerts,
    ansible_playbooks,
    app_catalog,
    audit,
    auth,
    automation,
    cameras,
    cluster,
    containers,
    credentials,
    health,
    host_groups,
    hosts,
    integrations,
    jobs,
    logs,
    metrics,
    patching,
    registries,
    security,
    services,
    traffic,
    vpn,
)
from app.core.config import get_settings
from app.db.session import async_session_factory
from app.middleware.audit import AuditLogMiddleware
from app.models.host import Host
from app.services.prometheus_sd import write_node_exporter_targets
from app.services.traffic_watch import start_traffic_watch

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Regenerate the Prometheus file_sd target file on boot in case it drifted
    # (or never existed) while the API wasn't running to react to changes.
    async with async_session_factory() as db:
        result = await db.execute(select(Host))
        write_node_exporter_targets(list(result.scalars().all()))
    await start_traffic_watch()
    yield


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],  # same-origin via reverse proxy in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditLogMiddleware)

_AUTH = [Depends(get_current_user)]

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(auth.router, prefix="/api", tags=["auth"])  # login is intentionally unauthenticated
app.include_router(audit.router, prefix="/api", tags=["audit"])  # route-level require_role("admin")

app.include_router(hosts.router, prefix="/api", tags=["hosts"], dependencies=_AUTH)
app.include_router(host_groups.router, prefix="/api", tags=["host-groups"], dependencies=_AUTH)
app.include_router(credentials.router, prefix="/api", tags=["credentials"], dependencies=_AUTH)
app.include_router(automation.router, prefix="/api", tags=["automation"], dependencies=_AUTH)
app.include_router(jobs.router, prefix="/api", tags=["jobs"], dependencies=_AUTH)
app.include_router(alerts.router, prefix="/api", tags=["alerts"], dependencies=_AUTH)
app.include_router(services.router, prefix="/api", tags=["services"], dependencies=_AUTH)
app.include_router(patching.router, prefix="/api", tags=["patching"], dependencies=_AUTH)
app.include_router(security.router, prefix="/api", tags=["security"], dependencies=_AUTH)
app.include_router(containers.router, prefix="/api", tags=["containers"], dependencies=_AUTH)
app.include_router(cluster.router, prefix="/api", tags=["cluster"], dependencies=_AUTH)
app.include_router(cameras.router, prefix="/api", tags=["cameras"], dependencies=_AUTH)
app.include_router(vpn.router, prefix="/api", tags=["vpn"], dependencies=_AUTH)
# No dependencies=_AUTH here - see cameras.stream_router's own module
# comment (an <img> tag can't send an Authorization header, same reason as
# ai.stream_router below). Auth for this one route is manual via a `token`
# query param.
app.include_router(cameras.stream_router, prefix="/api", tags=["cameras"])
# No dependencies=_AUTH here - see containers.ws_router's own docstring for
# why a router-level HTTPBearer dependency 500s on a WebSocket scope. Auth
# for its one route (the Console WS) is fully manual inside the handler.
app.include_router(containers.ws_router, prefix="/api", tags=["containers"])
app.include_router(registries.router, prefix="/api", tags=["registries"], dependencies=_AUTH)
app.include_router(app_catalog.router, prefix="/api", tags=["app-catalog"], dependencies=_AUTH)
app.include_router(logs.router, prefix="/api", tags=["logs"], dependencies=_AUTH)
app.include_router(metrics.router, prefix="/api", tags=["metrics"], dependencies=_AUTH)
app.include_router(ansible_playbooks.router, prefix="/api", tags=["ansible"], dependencies=_AUTH)
app.include_router(traffic.router, prefix="/api", tags=["traffic"], dependencies=_AUTH)
# Registered BEFORE ai.router deliberately: Starlette matches routes in
# registration order across the whole app, not per-router, and
# /ai/agents/{agent_id} (below) would otherwise shadow the literal
# /ai/agents/stream path - "stream" is a perfectly valid (if never
# resolvable) agent_id string at the pure path-matching stage, and
# get_current_user's dependencies=_AUTH on that route would reject the
# request (401 "not authenticated") before FastAPI ever tried to parse
# "stream" as a UUID. No dependencies=_AUTH here - see stream_router's own
# module-level comment for why (EventSource can't send an Authorization
# header). Auth for this one route is fully manual inside the handler via
# a `token` query param.
app.include_router(ai.stream_router, prefix="/api", tags=["ai"])
app.include_router(ai_memory.router, prefix="/api", tags=["ai-memory"], dependencies=_AUTH)
app.include_router(ai.router, prefix="/api", tags=["ai"], dependencies=_AUTH)
# No dependencies=_AUTH: Nextcloud signs each webhook with the bot's shared
# secret and the handler verifies that itself - see the module docstring.
app.include_router(integrations.router, prefix="/api", tags=["integrations"])
