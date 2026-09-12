import asyncio
import json
import httpx
import pytest
from fastapi import HTTPException
from app.core.config import get_settings
from app.services import wireguard
from app.api.routes import vpn

@pytest.fixture
def integration(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRETS_ROOT", str(tmp_path))
    monkeypatch.setenv("WIREGUARD_URL", "https://vpn-admin.example.com")
    (tmp_path / "integrations").mkdir()
    (tmp_path / "integrations/wireguard-admin-password").write_text("test-service-password\n")
    get_settings.cache_clear()
    yield tmp_path
    get_settings.cache_clear()

def mock_server(monkeypatch, handler):
    real = httpx.AsyncClient
    def factory(**kwargs):
        assert kwargs["base_url"].startswith("https://")
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return real(**kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(wireguard.httpx, "AsyncClient", factory)

def test_authenticated_cookie_reaches_peer_api_and_is_logged_out(integration, monkeypatch):
    seen=[]
    def handler(req):
        seen.append((req.method,req.url.path))
        if req.method=="POST":
            assert json.loads(req.content)=={"password":"test-service-password"}
            return httpx.Response(200,json={"success":True},headers={"Set-Cookie":"connect.sid=test; Path=/; HttpOnly"})
        assert req.headers["cookie"]=="connect.sid=test"
        assert "authorization" not in req.headers
        return httpx.Response(200,json=[] if req.method=="GET" else {"success":True})
    mock_server(monkeypatch,handler)
    assert asyncio.run(vpn._list_raw())==[]
    assert seen==[("POST","/api/session"),("GET","/api/wireguard/client"),("DELETE","/api/session")]

@pytest.mark.parametrize("status",[401,403,302,500])
def test_failed_login_never_calls_peer_api(integration,monkeypatch,status):
    seen=[]
    def handler(req):
        seen.append(req.url.path)
        return httpx.Response(status,text="test-service-password",headers={"Location":"https://other.invalid"})
    mock_server(monkeypatch,handler)
    with pytest.raises(HTTPException) as exc:asyncio.run(vpn._list_raw())
    assert "test-service-password" not in exc.value.detail
    assert seen==["/api/session"]

def test_missing_secret_does_not_contact_upstream(integration,monkeypatch):
    (integration/"integrations/wireguard-admin-password").unlink()
    mock_server(monkeypatch,lambda req:pytest.fail("No upstream call permitted"))
    with pytest.raises(HTTPException) as exc:asyncio.run(vpn._list_raw())
    assert exc.value.status_code==503

def test_failed_mutation_is_not_retried_and_session_is_closed(integration,monkeypatch):
    paths=[]
    def handler(req):
        paths.append((req.method,req.url.path))
        if req.method=="POST":return httpx.Response(200,headers={"Set-Cookie":"connect.sid=test; Path=/"})
        if req.url.path=="/api/wireguard/client/test-peer":raise httpx.ReadTimeout("test-service-password",request=req)
        return httpx.Response(200,json={"success":True})
    mock_server(monkeypatch,handler)
    with pytest.raises(HTTPException) as exc:asyncio.run(vpn.delete_peer("test-peer"))
    assert "test-service-password" not in exc.value.detail
    assert paths==[("POST","/api/session"),("DELETE","/api/wireguard/client/test-peer"),("DELETE","/api/session")]

def test_http_destination_rejected_before_credentials_sent(integration,monkeypatch):
    monkeypatch.setenv("WIREGUARD_URL","http://wireguard.invalid");get_settings.cache_clear()
    mock_server(monkeypatch,lambda req:pytest.fail("No HTTP credential transmission"))
    with pytest.raises(HTTPException) as exc:asyncio.run(vpn._list_raw())
    assert exc.value.status_code==503
