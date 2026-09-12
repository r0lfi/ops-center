import json
from app.services.traffic_reader import (
    classify as raw_classify,
    parse_line as raw_parse,
)
from functools import partial

CONFIG = {
    "id": "media",
    "application": "jellyfin",
    "auth_domains": ["media.example.com"],
}
classify = partial(raw_classify, config=CONFIG)
parse_line = partial(raw_parse, config=CONFIG)
from app.services.traffic_security import detect
from test_traffic import LINE

NOW = 10000


def event(i=0, **kw):
    return {
        "ts": NOW - 100 + i,
        "ip": "8.8.8.8",
        "domain": "media.example.com",
        "kind": "http",
        "status": 401,
        "signal": "auth_failure",
        **kw,
    }


def rules(events, baseline=None, ready=False):
    return {a["rule"]: a for a in detect(events, baseline or {}, NOW, ready)}


def test_only_verified_media_post_upstream_success_means_login():
    assert (
        classify(
            "media.example.com",
            "POST",
            "/Users/AuthenticateByName?api_key=SECRET",
            200,
            "200",
        )
        == "auth_success"
    )
    for domain, method, path, status, upstream in [
        ("media.example.com", "GET", "/Users/AuthenticateByName", 200, "200"),
        ("media.example.com", "POST", "/Users/AuthenticateByName", 200, "-"),
        ("media.example.com", "POST", "/Users/AuthenticateByName", 302, "302"),
        ("other.example", "POST", "/Users/AuthenticateByName", 200, "200"),
        ("media.example.com", "POST", "/login", 200, "200"),
        ("media.example.com", "POST", "/Videos/123/stream", 200, "200"),
    ]:
        assert classify(domain, method, path, status, upstream) != "auth_success"


def test_npm_signal_does_not_retain_tokens_or_path():
    row = parse_line(
        LINE.replace("GET", "POST").replace(
            "/secret?token=NEVER_STORE", "/Users/AuthenticateByName?api_key=NEVER_STORE"
        ),
        "npm",
    )
    assert row["signal"] == "auth_success"
    assert "NEVER_STORE" not in json.dumps(row) and "path" not in row
    assert (
        parse_line(
            LINE.replace("GET", "POST")
            .replace("/secret?token=NEVER_STORE", "/Users/AuthenticateByName")
            .replace("- 200 200", "- 401 401"),
            "npm",
        )["signal"]
        == "auth_failure"
    )


def test_generic_403_is_not_a_bad_password():
    assert classify("vpn-admin.example.com", "GET", "/", 403, "-") is None
    assert classify("media.example.com", "GET", "/Items", 401, "401") is None
    assert (
        classify("media.example.com", "POST", "/Users/AuthenticateByName", 429, "-")
        == "auth_throttled"
    )


def test_probe_path_is_decoded_and_query_does_not_trigger():
    assert classify("site.example", "GET", "/%2eenv?token=secret", 404) == "probe"
    assert classify("site.example", "GET", "/ok?next=/.env", 200) is None


def test_bruteforce_rolling_window_and_client_isolation():
    assert "auth_burst" in rules([event(i) for i in range(10)])
    assert "auth_burst" not in rules([event(i, ts=NOW - 301) for i in range(10)])
    assert "auth_burst" not in rules(
        [event(i, ip="8.8.4." + str(i)) for i in range(10)]
    )


def test_success_after_failures_requires_correct_order_and_service():
    bad = [event(i) for i in range(5)]
    success = event(80, status=200, signal="auth_success")
    assert rules([success] + bad)["success_after_failures"]["severity"] == "high"
    assert "success_after_failures" not in rules(bad + [dict(success, ts=NOW - 200)])
    assert "success_after_failures" not in rules(
        bad + [dict(success, domain="different.example")]
    )
    assert "success_after_failures" not in rules(
        [dict(e, signal=None) for e in bad] + [success]
    )


def test_distributed_rejections_require_multiple_clients():
    distributed = [event(i, ip="8.8.4." + str(i % 5 + 1)) for i in range(30)]
    assert "auth_distributed" in rules(distributed)
    assert "auth_distributed" not in rules([event(i) for i in range(30)])


def test_streaming_and_warmup_are_not_bruteforce():
    normal = [event(i % 80, status=200, signal=None) for i in range(1000)]
    assert rules(normal) == {}
    assert set(rules(normal, {"media.example.com": 1200}, True)) == {"traffic_spike"}
    assert rules(normal, {"media.example.com": 12000}, True) == {}


def test_scan_and_errors_are_evidence_not_compromise():
    assert "path_scan" in rules(
        [event(i, signal="probe", status=404) for i in range(20)]
    )
    assert "error_burst" in rules(
        [event(i % 80, signal=None, status=502) for i in range(100)]
    )
    assert "success_after_failures" not in rules(
        [event(i, signal=None, status=200) for i in range(20)]
    )


def test_review_requires_admin():
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.api.routes.traffic import router
    from app.api.deps import get_current_user

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(role="viewer")
    assert TestClient(app).post("/traffic/security/1/review").status_code == 403


def test_success_window_includes_failures_before_current_fifteen_minutes():
    failed = [event(i, ts=NOW - 990 + i) for i in range(5)]
    early = event(status=200, signal="auth_success", ts=NOW - 100)
    later = event(status=200, signal="auth_success", ts=NOW - 1)
    assert "success_after_failures" in rules(failed + [early, later])
