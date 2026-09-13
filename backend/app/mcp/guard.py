"""Transport limits and resource binding around the SDK's OAuth routes."""

import json
import time
from collections import OrderedDict
from urllib.parse import parse_qs, urlsplit
from starlette.responses import JSONResponse
from app.core.config import get_settings
from app.mcp.common import public_url, origin


class MCPGuard:
    def __init__(self, app):
        self.app = app
        self.buckets = OrderedDict()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        managed = (
            path == "/mcp"
            or path.startswith("/api/mcp/")
            or path in ("/authorize", "/token", "/revoke")
            or path.startswith("/.well-known/")
        )
        if not managed:
            return await self.app(scope, receive, send)

        async def reject(status, message):
            await JSONResponse(
                {"error": "invalid_request", "error_description": message},
                status_code=status,
                headers={"Cache-Control": "no-store"},
            )(scope, receive, send)

        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        # Apply origin checks to OAuth as well as the MCP transport. Browser
        # management API uses only its own origin and never cookie authentication.
        try:
            base = origin()
        except ValueError:
            base = None
        if base and path not in ("/api/mcp/settings",):
            host = headers.get(b"host", b"").decode()
            if path == "/mcp" or not path.startswith("/api/"):
                if host != urlsplit(base).netloc:
                    return await reject(421, "Unexpected MCP host")
            allowed = (
                [base]
                if path.startswith("/api/")
                else [base, *get_settings().mcp_allowed_origins]
            )
            if b"origin" in headers and headers[b"origin"].decode() not in allowed:
                return await reject(403, "Origin is not permitted")
        stamp = time.monotonic()
        # Client address comes from the server, never an arbitrary forwarded header.
        key = (scope.get("client") or ("unknown", 0))[0]
        start, count = self.buckets.pop(key, (stamp, 0))
        if stamp - start >= 60:
            start, count = stamp, 0
        self.buckets[key] = (start, count + 1)
        while len(self.buckets) > 10000:
            self.buckets.popitem(last=False)
        if count >= 240:
            return await reject(429, "MCP request rate exceeded; retry later")
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > 131072:
                return await reject(413, "MCP request body too large")
            chunks.append(chunk)
            if not message.get("more_body"):
                break
        body = b"".join(chunks)
        if path in ("/authorize", "/token", "/revoke"):
            try:
                data = parse_qs(
                    (
                        scope.get("query_string", b"")
                        if scope["method"] == "GET"
                        else body
                    ).decode(),
                    keep_blank_values=True,
                    max_num_fields=30,
                )
            except (ValueError, UnicodeError):
                return await reject(400, "Malformed OAuth request")
            if any(len(v) != 1 for v in data.values()):
                return await reject(400, "Repeated OAuth parameters are not permitted")
            if path in ("/authorize", "/token"):
                if not base or data.get("resource") != [public_url()]:
                    return await reject(400, "Use the advertised MCP resource URL")
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        async def no_cache(message):
            if message["type"] == "http.response.start":
                message["headers"] = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() not in (b"cache-control", b"pragma")
                ]
                message["headers"] += [
                    (b"cache-control", b"no-store"),
                    (b"pragma", b"no-cache"),
                    (b"referrer-policy", b"no-referrer"),
                ]
            await send(message)

        await self.app(scope, replay, no_cache)
