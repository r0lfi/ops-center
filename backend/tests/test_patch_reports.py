from types import SimpleNamespace

from app.services.patch_reports import host_results


def event(kind, host=None, message=None, task=None):
    return SimpleNamespace(event_type=kind, host=host, message=message, task=task)


def job(status, *events):
    return SimpleNamespace(status=status, events=events)


def test_mixed_recap_is_authoritative_and_strips_ansi():
    result = host_results(job("failed",
        event("runner_on_ok", "healthy", task="Gathering Facts"),
        event("runner_on_failed", "broken", "Package transaction failed", "Install updates"),
        event("playbook_on_stats", message="\x1b[32mhealthy : ok=4 changed=2 unreachable=0 failed=0 skipped=1 rescued=0 ignored=0\x1b[0m\nbroken : ok=1 changed=0 unreachable=0 failed=1\noffline : ok=0 changed=0 unreachable=1 failed=0"),
    ))
    assert [(h["host"], h["status"]) for h in result] == [("broken", "failed"), ("healthy", "successful"), ("offline", "unreachable")]
    assert result[0]["message"] == "Package transaction failed"
    assert result[1]["changed"] == 2


def test_intermediate_ok_does_not_imply_patching_completed():
    result = host_results(job("failed", event("runner_on_ok", "host", task="Gathering Facts")))
    assert result[0]["status"] == "unknown"
    assert result[0]["changed"] is None


def test_cancelled_partial_recap_is_not_success():
    result = host_results(job("cancelled", event("playbook_on_stats", message="host : ok=1 changed=0 unreachable=0 failed=0")))
    assert result[0]["status"] == "cancelled"


def test_ignored_or_rescued_failure_is_warning():
    result = host_results(job("successful",
        event("runner_on_failed", "host", "Temporary error"),
        event("playbook_on_stats", message="host : ok=3 changed=0 unreachable=0 failed=0 skipped=0 rescued=1 ignored=0"),
    ))
    assert result[0]["status"] == "warning"


def test_missing_events_and_running_jobs():
    assert host_results(job("failed")) == []
    assert host_results(job("running", event("runner_on_ok", "host")))[0]["status"] == "running"


def test_explicit_failure_without_recap_is_visible():
    result = host_results(job("failed", event("runner_on_unreachable", "host", "SSH timeout")))
    assert result[0]["status"] == "unreachable"
    assert result[0]["message"] == "SSH timeout"


def test_report_queries_filter_before_pagination_and_skip_scan_jobs():
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    from sqlalchemy.dialects import postgresql
    from app.api.routes.patching import patch_reports

    db = AsyncMock()
    db.scalar.return_value = 42
    rows = MagicMock()
    rows.scalars.return_value = []
    db.execute.return_value = rows
    response = asyncio.run(patch_reports(status="failed", group="Auto_patch%", offset=25, limit=25, db=db))
    assert response == {"total": 42, "items": []}
    query = str(db.execute.call_args.args[0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "patch-check.yml" not in query
    assert "pihole-update.yml" in query
    assert "ansible_jobs.status = 'failed'" in query
    assert "LIMIT 25 OFFSET 25" in query
    assert "ESCAPE '/'" in query  # group names containing SQL wildcards stay literal
    assert "JOIN ansible_events" not in query


def test_detail_rejects_non_patch_jobs():
    import asyncio
    import uuid
    from unittest.mock import AsyncMock, MagicMock
    from fastapi import HTTPException
    from app.api.routes.patching import patch_report
    import pytest

    db = AsyncMock()
    rows = MagicMock()
    rows.scalar_one_or_none.return_value = None
    db.execute.return_value = rows
    with pytest.raises(HTTPException) as error:
        asyncio.run(patch_report(uuid.uuid4(), db=db))
    assert error.value.status_code == 404
