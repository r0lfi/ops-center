from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.middleware.audit import AuditLogMiddleware

def test_collaboration_input_is_not_copied_into_shared_audit():
    app = FastAPI()
    app.add_middleware(AuditLogMiddleware)
    @app.post("/api/ai/collaboration/boards")
    async def create():
        return {"ok": True}
    session = AsyncMock()
    session.add = MagicMock()
    factory = MagicMock()
    factory.return_value.__aenter__ = AsyncMock(return_value=session)
    factory.return_value.__aexit__ = AsyncMock(return_value=False)
    with patch("app.middleware.audit.async_session_factory", factory), TestClient(app) as client:
        response = client.post("/api/ai/collaboration/boards", json={"agent": "linux", "message": "private incident details", "conversation_key": "private context"})
    assert response.status_code == 200
    entry = session.add.call_args.args[0]
    assert entry.parameters == {"agent": "linux", "message": "[private collaboration input omitted]"}
    assert entry.target == "/api/ai/collaboration/boards"
    assert entry.result == "200"

def test_existing_secret_redaction_is_preserved():
    from app.middleware.audit import _audit_parameters
    assert _audit_parameters("/api/auth/login", {"password": "secret", "username": "alice"}) == {"password": "***redacted***", "username": "alice"}
    assert _audit_parameters("/api/ai/collaboration/boards/", {"message": "private"})["message"] == "[private collaboration input omitted]"
