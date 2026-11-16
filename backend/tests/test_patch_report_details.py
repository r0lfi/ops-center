"""Patch report details: per-host package changes and performed tasks."""

import json
from types import SimpleNamespace

from app.services.patch_reports import PACKAGE_MARKER, host_results


def event(event_type, host=None, task=None, message=None):
    return SimpleNamespace(event_type=event_type, host=host, task=task, message=message)


def test_package_changes_and_tasks_per_host():
    report = {"changes": [{"name": "kernel-core", "from": "6.12.0-1", "to": "6.12.0-1, 6.12.0-2"},
                          {"name": "old-lib", "from": "1.0-1", "to": ""}], "reboot_required": "yes"}
    job = SimpleNamespace(status="successful", events=[
        event("runner_on_ok", "h1", "Gathering Facts", "ok: [h1]"),
        event("runner_on_ok", "h1", "Record installed packages before patching", "ok: [h1]"),
        event("runner_on_ok", "h1", "RHEL family - install all updates", "changed: [h1]"),
        event("runner_on_skipped", "h1", "Debian family - full dist-upgrade", "skipping: [h1]"),
        event("runner_on_ok", "h1", "Report package changes", PACKAGE_MARKER + json.dumps(report)),
        event("playbook_on_stats", message="h1 : ok=6    changed=1    unreachable=0    failed=0    skipped=1"),
    ])
    [row] = host_results(job)
    assert row["status"] == "successful" and row["changed"] == 1
    assert row["packages"] == report["changes"] and row["reboot_required"] == "yes"
    assert row["tasks"] == [{"task": "Gathering Facts", "result": "ok"},
                            {"task": "RHEL family - install all updates", "result": "changed"},
                            {"task": "Debian family - full dist-upgrade", "result": "skipped"}]


def test_pihole_output_and_old_runs_without_report():
    job = SimpleNamespace(status="successful", events=[
        event("runner_on_ok", "dns", "Run pihole -up", "changed: [dns]"),
        event("runner_on_ok", "dns", "Report outcome", json.dumps(["  [i] Checking for updates...", "  [✓] Everything is up to date"])),
        event("playbook_on_stats", message="dns : ok=2    changed=1    unreachable=0    failed=0"),
    ])
    [row] = host_results(job)
    assert "packages" not in row and "Everything is up to date" in row["output"]
