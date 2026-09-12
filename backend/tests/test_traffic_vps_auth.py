import json
from types import SimpleNamespace
from app.services import traffic_ssh_reader as ssh
from app.services import traffic_auth as auth
from app.services.traffic_reader import parse_line


def record(message, cursor="entry"):
    return {
        "MESSAGE": message,
        "_COMM": "sshd-session",
        "__CURSOR": cursor,
        "__REALTIME_TIMESTAMP": "1000000000",
    }


def test_ssh_acceptance_and_rejection_are_not_connection_events():
    accepted = ssh.parse(
        record(
            "Accepted publickey for SECRET_USER from 8.8.8.8 port 50000 ssh2: ED25519 SECRET_KEY"
        )
    )
    assert accepted["signal"] == "auth_success" and accepted["kind"] == "ssh"
    assert "SECRET" not in json.dumps(accepted)
    assert (
        ssh.parse(
            record("Failed password for invalid user ROOT from 8.8.8.8 port 44 ssh2")
        )
        is None
    )
    for message in (
        "Invalid user test from 1.1.1.1 port 44",
        "Connection closed by authenticating user root 1.1.1.1 port 44 [preauth]",
        "Connection reset by 1.1.1.1 port 44 [preauth]",
    ):
        assert ssh.parse(record(message)) is None
    assert (
        ssh.parse(record("pam_unix(sshd:session): session opened for user root"))
        is None
    )
    assert (
        ssh.parse(
            {
                **record("Accepted password for root from 1.1.1.1 port 4"),
                "_COMM": "untrusted",
            }
        )
        is None
    )


def test_ssh_only_current_dns_is_exempt_even_in_norway():
    policy = {"countries": ["Norway"], "addresses": ["8.8.8.8"]}
    event = {
        "ts": 100,
        "ip": "1.1.1.1",
        "country": "Norway",
        "kind": "ssh",
        "domain": "edge-host",
        "signal": "auth_success",
    }
    assert auth.candidate(event, policy)["rule"] == "foreign_ssh"
    assert auth.candidate({**event, "ip": "8.8.8.8"}, policy) is None
    assert auth.candidate({**event, "signal": "auth_attempt"}, policy) is None
    assert (
        auth.candidate({**event, "signal": "auth_failure", "ip": "8.8.8.8"}, policy)
        is None
    )
    assert (
        auth.candidate({**event, "domain": "admin.example.com", "kind": "auth"}, policy)
        is None
    )
    assert (
        auth.candidate(
            {
                **event,
                "domain": "admin.example.com",
                "kind": "auth",
                "country": "Germany",
            },
            policy,
        )["severity"]
        == "high"
    )


def test_application_uses_explicit_audit_not_http_200():
    raw = {
        "id": "a" * 32,
        "ts": 100,
        "ip": "8.8.8.8",
        "signal": "auth_failure",
        "password": "NEVER_STORE",
    }
    parsed = parse_line(
        json.dumps(raw),
        "auth_audit",
        {"id": "admin-audit", "domain": "admin.example.com"},
    )
    assert (
        parsed["signal"] == "auth_failure"
        and parsed["status"] is None
        and parsed["kind"] == "auth"
    )
    assert "NEVER_STORE" not in json.dumps(parsed)
    assert (
        parse_line(
            json.dumps({**raw, "signal": "auth_success"}),
            "auth_audit",
            {"id": "admin-audit", "domain": "admin.example.com"},
        )["signal"]
        == "auth_success"
    )
    assert (
        parse_line(
            json.dumps({**raw, "id": "../untrusted"}),
            "auth_audit",
            {"id": "admin-audit", "domain": "admin.example.com"},
        )
        is None
    )


def test_ssh_first_start_establishes_cursor_without_replaying_old_logins(monkeypatch):
    monkeypatch.setattr(
        ssh.subprocess,
        "check_output",
        lambda *a, **kw: json.dumps(
            record("Accepted password for owner from 8.8.8.8 port 44")
        ),
    )
    result = ssh.collect({})
    assert not result["events"] and result["checkpoint"]["cursor"] == "entry"


def test_ssh_cursor_preserves_backlog_and_duplicate_identity(monkeypatch):
    rows = [
        record("Accepted publickey for test from 8.8.8.8 port 44", str(i))
        for i in range(501)
    ]
    monkeypatch.setattr(
        ssh.subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0, stdout="\n".join(map(json.dumps, rows))
        ),
    )
    result = ssh.collect({"cursor": "old", "since": 999})
    assert (
        len(result["events"]) == 500
        and result["checkpoint"]["cursor"] == "499"
        and result["checkpoint"]["backlog"]
    )
    assert result["events"][0]["event_key"] == ssh.parse(rows[0])["event_key"]


def test_ssh_journal_rotation_falls_back_to_saved_time_with_visible_gap(monkeypatch):
    monkeypatch.setattr(
        ssh.subprocess, "run", lambda *a, **kw: SimpleNamespace(returncode=1)
    )
    monkeypatch.setattr(
        ssh.subprocess,
        "check_output",
        lambda *a, **kw: json.dumps(
            record("Failed password for owner from 8.8.8.8 port 44")
        ),
    )
    result = ssh.collect({"cursor": "vacuumed", "since": 999})
    assert result["checkpoint"]["history_gap"] and result["events"] == []


def test_ssh_is_only_evaluated_by_its_explicit_origin_policy():
    from app.services.traffic_security import detect

    events = [
        {
            "ts": 900 + i,
            "ip": "8.8.8.8",
            "country": "Norway",
            "domain": "edge-host",
            "kind": "ssh",
            "status": None,
            "signal": "auth_failure",
        }
        for i in range(10)
    ]
    events.append({**events[0], "ts": 990, "signal": "auth_success"})
    assert detect(events, {}, 1000) == []
    policy = {"countries": ["Norway"], "addresses": ["8.8.8.8"]}
    assert all(auth.candidate(e, policy) is None for e in events)


def test_ssh_unsuccessful_authentication_never_alerts():
    policy = {"countries": ["Norway"], "addresses": []}
    for signal in ("auth_attempt", "auth_failure", "auth_throttled"):
        assert (
            auth.candidate(
                {
                    "ts": 100,
                    "ip": "1.1.1.1",
                    "country": "Germany",
                    "kind": "ssh",
                    "domain": "edge-host",
                    "signal": signal,
                },
                policy,
            )
            is None
        )
