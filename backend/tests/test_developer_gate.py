"""The production approval gate cannot be passed without a fresh password in a browser session."""
import asyncio
import time
import uuid
from types import SimpleNamespace

import httpx
from fastapi import Depends, FastAPI, Request

from app.api.deps import get_current_user, require_recent_auth
from app.api.routes.ai_developer import checks, diffstat
from app.models.ai import AIToolProposal
from app.models.user import User

ADMIN = User(id=uuid.uuid4(), username="admin", role="admin", is_active=True)


def call(payload, user=ADMIN):
    app = FastAPI()

    async def current(request: Request):
        if payload is not None:
            request.state.token_payload = payload
        return user

    app.dependency_overrides[get_current_user] = current

    @app.post("/gate")
    async def gate(_=Depends(require_recent_auth("admin"))):
        return {"ok": True}

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
            return await client.post("/gate")
    return asyncio.run(run())


def test_fresh_browser_session_passes():
    assert call({"sid": "s", "auth_time": int(time.time())}).status_code == 200


def test_agent_mcp_principal_without_session_is_refused():
    # MCP and agent principals never carry a browser session payload.
    assert call(None).status_code == 403


def test_local_script_token_is_refused():
    assert call({"local": True, "auth_time": int(time.time())}).status_code == 403


def test_stale_password_confirmation_is_refused():
    r = call({"sid": "s", "auth_time": int(time.time()) - 3600})
    assert r.status_code == 403 and r.headers["x-reauth-required"] == "1"


def test_non_admin_is_refused():
    viewer = User(id=uuid.uuid4(), username="v", role="operator", is_active=True)
    assert call({"sid": "s", "auth_time": int(time.time())}, viewer).status_code == 403


def test_diffstat_and_checks_report_only_what_was_checked():
    patch = ("diff --git a/docs/x.md b/docs/x.md\n--- a/docs/x.md\n+++ b/docs/x.md\n+a\n+b\n-c\n"
             "diff --git a/compose.yml b/compose.yml\n--- a/compose.yml\n+++ b/compose.yml\n+x\n")
    assert diffstat(patch) == [{"path": "docs/x.md", "added": 2, "removed": 1, "status": "modified"},
                               {"path": "compose.yml", "added": 1, "removed": 0, "status": "modified"}]
    row = AIToolProposal(title="t", details={}, status="ready_for_review", patch=patch)
    result = {c["name"]: c["result"] for c in checks(row)}
    assert result == {"Credential scan": "passed", "Path allowlist": "failed", "Tests included": "warning", "Test run": "not_run"}
    assert checks(SimpleNamespace(patch=patch, status="in_development")) == []
