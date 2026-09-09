import json

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.db.session import async_session_factory
from app.models.audit import AuditLogEntry
from app.services.auth import decode_access_token

_REDACT_KEYS = ("password", "access_token", "token", "secret", "confirm", "credential", "key", "apikey")
_SKIP_PATH_PREFIXES = ("/api/health", "/api/docs", "/api/redoc", "/api/openapi.json")


def _redact(value):
    if isinstance(value, dict):
        return {
            k: (
                "***redacted***"
                if any(term in k.lower() for term in _REDACT_KEYS)
                else _redact(v)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def _user_from_request(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    payload = decode_access_token(auth[len("Bearer ") :])
    return payload.get("username") if payload else None


class AuditLogMiddleware(BaseHTTPMiddleware):
    """
    Every state-changing (non-GET) /api/* request gets an audit_log row:
    user, timestamp, source IP, action (method), target (path), parameters
    (request body, secrets redacted), result (status code). Logging never
    blocks or fails the actual request - a logging error is swallowed.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        should_audit = (
            request.url.path.startswith("/api/")
            and request.method != "GET"
            and not request.url.path.startswith(_SKIP_PATH_PREFIXES)
        )

        body_json: dict = {}
        if should_audit:
            try:
                raw = await request.body()
                if raw:
                    body_json = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                body_json = {}

        response = await call_next(request)

        if should_audit:
            try:
                async with async_session_factory() as db:
                    db.add(
                        AuditLogEntry(
                            user=_user_from_request(request),
                            source_ip=request.client.host if request.client else None,
                            action=request.method,
                            target=request.url.path,
                            parameters=_redact(body_json),
                            result=str(response.status_code),
                        )
                    )
                    await db.commit()
            except Exception:
                pass  # audit logging must never break the actual request

        return response
