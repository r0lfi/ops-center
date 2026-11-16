import pytest

from security import events
from security.events import _is_healthcheck_exec

HEALTHCHECK = "wget -qO- http://localhost:8080/healthz"


def _event(action: str, exec_id: str = "e1", container: str = "c1") -> dict:
    return {"Action": action, "Actor": {"ID": container, "Attributes": {"execID": exec_id}}}


@pytest.fixture(autouse=True)
def known_healthcheck(monkeypatch):
    monkeypatch.setattr(events, "_healthcheck_commands", {"c1": HEALTHCHECK, "none": None})
    monkeypatch.setattr(events, "_healthcheck_exec_ids", set())


def test_all_three_events_of_a_healthcheck_are_dropped():
    assert _is_healthcheck_exec(_event(f"exec_create: {HEALTHCHECK}"))
    assert _is_healthcheck_exec(_event(f"exec_start: {HEALTHCHECK}"))
    assert _is_healthcheck_exec(_event("exec_die"))
    assert events._healthcheck_exec_ids == set()


def test_a_person_running_a_command_is_kept():
    assert not _is_healthcheck_exec(_event("exec_create: sh -c cat /etc/shadow", "e2"))
    assert not _is_healthcheck_exec(_event("exec_start: sh -c cat /etc/shadow", "e2"))
    assert not _is_healthcheck_exec(_event("exec_die", "e2"))


def test_unknown_containers_and_missing_exec_ids_are_kept(monkeypatch):
    monkeypatch.setattr(events, "_healthcheck_command", lambda _: None)
    assert not _is_healthcheck_exec(_event(f"exec_create: {HEALTHCHECK}", container="other"))
    assert not _is_healthcheck_exec({"Action": f"exec_create: {HEALTHCHECK}", "Actor": {"ID": "c1"}})


def test_lifecycle_events_are_kept():
    for action in ("start", "die", "restart", "pull", "health_status: unhealthy"):
        assert not _is_healthcheck_exec(_event(action))
    assert not _is_healthcheck_exec({"status": "start"})
    assert not _is_healthcheck_exec({})


@pytest.mark.parametrize(
    "test,expected",
    [
        (["CMD", "curl", "-f", "http://x"], "curl -f http://x"),
        (["CMD-SHELL", "wget -q x || exit 1"], "/bin/sh -c wget -q x || exit 1"),
        (["NONE"], None),
    ],
)
def test_healthcheck_command_matches_docker_format(monkeypatch, test, expected):
    class Done:
        stdout = events.json.dumps({"Test": test})

    monkeypatch.setattr(events.subprocess, "run", lambda *a, **k: Done)
    monkeypatch.setattr(events, "_healthcheck_commands", {})
    assert events._healthcheck_command("c9") == expected
