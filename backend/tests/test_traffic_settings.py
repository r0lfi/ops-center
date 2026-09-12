"""Configuration validation, administrator boundaries and source isolation."""

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.deps import get_current_user
from app.api.routes import traffic_settings as routes
from app.models.host import Host
from app.models.traffic import TrafficSettings
from app.schemas.traffic_settings import TrafficSettingsConfig, TrafficSourceConfig
from app.services.traffic_reader import classify, parse_line
from app.services import traffic_auth, traffic_ssh_reader


def source(**overrides):
    return TrafficSourceConfig(
        id="custom-proxy",
        label="My proxy",
        host_id=uuid4(),
        kind="npm",
        log_path="/var/log/nginx/access*.log",
        **overrides
    )


def test_new_installation_has_no_implicit_destinations_or_exemptions():
    settings = TrafficSettingsConfig()
    assert not settings.enabled and not settings.sources
    assert not settings.allowed_countries and not settings.trusted_dns
    assert (
        classify("media.example.com", "POST", "/Users/AuthenticateByName", 200, "200")
        is None
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"id": "security"},
        {"id": "../source"},
        {"log_path": "/var/log/../secrets"},
        {"log_path": "/var/log/$(id)"},
        {"log_path": "relative.log"},
        {"domain": "https://user:password@example.com"},
        {"container": "--privileged"},
        {"interface": "--help"},
        {"journal_unit": "--system"},
        {"application": "jellyfin", "auth_domains": []},
        {"ssh_command": "id"},
    ],
)
def test_source_rejects_unsafe_or_incomplete_configuration(patch):
    data = source().model_dump()
    with pytest.raises(ValidationError):
        TrafficSourceConfig.model_validate({**data, **patch})


def test_limits_duplicate_ids_and_dns_input():
    s = source()
    for data in (
        {"sources": [s, s]},
        {"trusted_dns": ["vpn.example.com:443"]},
        {"max_rows": 999},
        {"retention_days": 366},
    ):
        with pytest.raises(ValidationError):
            TrafficSettingsConfig.model_validate(data)
    assert TrafficSettingsConfig(trusted_dns=["VPN.Example.Com."]).trusted_dns == [
        "vpn.example.com"
    ]


@pytest.mark.parametrize("role", ["viewer", "operator"])
def test_settings_are_admin_only(role):
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role=role)
    client = TestClient(app)
    assert client.get("/settings/traffic").status_code == 403
    assert (
        client.put(
            "/settings/traffic", json=TrafficSettingsConfig().model_dump()
        ).status_code
        == 403
    )


def test_save_requires_current_revision_and_onboarded_managed_host(monkeypatch):
    s = source()
    settings = SimpleNamespace(revision=3, value={})
    host = SimpleNamespace(
        hostname="my-server", credential_id=None, ssh_host_fingerprint=None
    )

    class DB:
        @asynccontextmanager
        async def begin(self):
            yield self

        async def get(self, model, key, **kwargs):
            return (
                settings
                if model is TrafficSettings
                else host if model is Host else None
            )

    @asynccontextmanager
    async def sessions():
        yield DB()

    monkeypatch.setattr(routes, "async_session_factory", sessions)

    async def run():
        config = TrafficSettingsConfig(revision=2, enabled=True, sources=[s])
        with pytest.raises(HTTPException) as exc:
            await routes.put_traffic_settings(config)
        assert exc.value.status_code == 409
        config.revision = 3
        with pytest.raises(HTTPException) as exc:
            await routes.put_traffic_settings(config)
        assert exc.value.status_code == 422 and settings.revision == 3
        host.credential_id = uuid4()
        host.ssh_host_fingerprint = "SHA256:synthetic"
        result = await routes.put_traffic_settings(config)
        assert result.revision == 4 and result.sources[0].host_id == s.host_id

    asyncio.run(run())


def test_authentication_contract_and_event_identity_follow_configured_source():
    raw = json.dumps(
        {
            "id": "a" * 32,
            "ts": 100,
            "ip": "8.8.8.8",
            "signal": "auth_success",
            "password": "omit",
        }
    )
    a = parse_line(raw, "auth_audit", {"id": "app-one", "domain": "one.example.com"})
    b = parse_line(raw, "auth_audit", {"id": "app-two", "domain": "two.example.com"})
    assert a["event_key"] != b["event_key"] and a["domain"] == "one.example.com"
    assert "omit" not in json.dumps(a)
    policy = {"countries": [], "addresses": []}
    assert traffic_auth.candidate(a, policy)["source"] == "app-one"


def test_failed_ssh_requires_explicit_source_opt_in():
    record = {
        "MESSAGE": "Failed password for invalid user ignored from 8.8.8.8 port 45",
        "_COMM": "sshd",
        "__CURSOR": "test",
        "__REALTIME_TIMESTAMP": "1000000000",
    }
    assert traffic_ssh_reader.parse(record) is None
    event = traffic_ssh_reader.parse(record, {"id": "lab-ssh", "ssh_failures": True})
    policy = {"countries": [], "addresses": [], "ssh_failure_sources": ["lab-ssh"]}
    assert traffic_auth.candidate(event, policy)["rule"] == "ssh_rejected"
    assert traffic_auth.candidate({**event, "source": "other-ssh"}, policy) is None
