"""Exercise the assembled application with MCP enabled, including its catch-all mount."""
import os
import subprocess
import sys

import pytest


@pytest.mark.parametrize("mcp_url", ["", "https://ops.example/mcp"])
def test_im_routes_remain_reachable_and_authenticated_with_mcp(mcp_url):
    probe = """
import asyncio
import httpx
from app.main import app
async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="https://ops.example") as client:
        for method, path in [
            ("GET", "/api/ai/budget"),
            ("GET", "/api/incidents"),
            ("GET", "/api/incidents/1"),
            ("POST", "/api/incidents/1/status"),
            ("GET", "/api/settings/incidents"),
            ("PUT", "/api/settings/incidents"),
        ]:
            response = await client.request(method, path)
            assert response.status_code == 401, (method, path, response.status_code, response.text)
        if __import__("os").environ["MCP_PUBLIC_URL"]:
            response = await client.get("/.well-known/oauth-authorization-server")
            assert response.status_code == 200, response.text
asyncio.run(main())
"""
    result = subprocess.run(
        [sys.executable, "-c", probe],
        env={**os.environ, "MCP_PUBLIC_URL": mcp_url},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
