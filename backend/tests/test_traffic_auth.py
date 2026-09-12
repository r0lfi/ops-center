import asyncio
import socket
from types import SimpleNamespace
from app.services import traffic_auth as auth
from app.services.traffic_reader import classify as raw_classify
from app.schemas.traffic_settings import TrafficSettingsConfig
from functools import partial

classify = partial(
    raw_classify,
    config={"application": "wg_easy", "auth_domains": ["vpn-admin.example.com"]},
)

POLICY = {"countries": ["Norway"], "addresses": ["8.8.8.8", "2001:4860:4860::8888"]}


def event(**kw):
    return {
        "ts": 1000,
        "ip": "1.1.1.1",
        "country": "Germany",
        "kind": "http",
        "signal": "auth_success",
        "domain": "media.example.com",
        **kw,
    }


def test_trusted_countries_and_current_dns_only():
    assert auth.candidate(event(country="Norway"), POLICY) is None
    assert auth.candidate(event(ip="8.8.8.8"), POLICY) is None
    assert auth.candidate(event(ip="2001:4860:4860:0:0:0:0:8888"), POLICY) is None
    for country in ("Germany", "United States", "Israel", None):
        item = auth.candidate(event(country=country), POLICY)
        assert item["rule"] == "foreign_login" and item["severity"] == "high"
    assert auth.candidate(event(signal=None), POLICY) is None


def test_rejected_login_from_allowed_origins_still_alerts():
    for signal in ("auth_failure", "auth_throttled"):
        for country, ip in (("Norway", "1.1.1.1"), ("Germany", "8.8.8.8")):
            item = auth.candidate(event(country=country, ip=ip, signal=signal), POLICY)
            assert item["rule"] == "login_rejected" and item["severity"] == "warning"


def test_vpn_handshake_is_authenticated_observation_not_password_attempt():
    item = auth.candidate(
        event(kind="wireguard", signal=None, domain="vpn.example.com"), POLICY
    )
    assert (
        item["rule"] == "foreign_vpn" and item["evidence"]["outcome"] == "vpn_handshake"
    )
    assert auth.candidate(event(kind="wireguard", country="Norway"), POLICY) is None


def test_only_verified_wg_easy_session_submission_means_login():
    domain = "vpn-admin.example.com"
    assert classify(domain, "POST", "/api/session", 200, "200") == "auth_success"
    assert classify(domain, "POST", "/api/session", 401, "401") == "auth_failure"
    assert classify(domain, "POST", "/api/session", 429, "-") == "auth_throttled"
    for host, method, upstream in (
        (domain, "GET", "200"),
        (domain, "DELETE", "200"),
        (domain, "POST", "-"),
        ("vpn.example.com", "POST", "200"),
    ):
        assert classify(host, method, "/api/session", 200, upstream) != "auth_success"
    assert classify(domain, "GET", "/", 403, "-") is None


def test_dns_changes_and_failures_do_not_keep_old_exemptions(monkeypatch):
    async def configured():
        return TrafficSettingsConfig(
            trusted_dns=["vpn.example"], allowed_countries=["Norway"]
        )

    monkeypatch.setattr(auth, "load_config", configured)
    monkeypatch.setattr(auth, "_cache", None)
    monkeypatch.setattr(auth, "_cache_until", 0)

    async def run():
        responses = [
            "8.8.8.8",
            "1.1.1.1",
            None,
            "192." + "168.1.1",
            "2001:4860:4860::8888",
        ]

        async def resolve(*args, **kw):
            ip = responses.pop(0)
            if ip is None:
                raise socket.gaierror("Test DNS failure")
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
        first = await auth.trusted_origins()
        assert first["addresses"] == ["8.8.8.8"]
        assert (await auth.trusted_origins())["addresses"] == first[
            "addresses"
        ] and len(responses) == 4
        for expected in (["1.1.1.1"], [], [], ["2001:4860:4860::8888"]):
            monkeypatch.setattr(auth, "_cache_until", 0)
            result = await auth.trusted_origins()
            assert result["addresses"] == expected
            assert bool(result["error"]) == (not expected)

    asyncio.run(run())


def test_authentication_query_validates_result_and_page():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.routes.traffic import router

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    assert client.get("/traffic/security?auth_result=invalid").status_code == 422
    assert client.get("/traffic/security?auth_offset=-1").status_code == 422
