"""Read historical patch outcomes without inferring success from intermediate tasks."""
import re

PATCH_PLAYBOOKS = ("patch-security.yml", "patch-all.yml", "pihole-update.yml")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
RECAP = re.compile(r"^\s*(\S+)\s+:\s+ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)(.*)$", re.M)


def host_results(job):
    hosts = {}
    recaps = {}
    for event in job.events:
        if event.host:
            row = hosts.setdefault(event.host, {"host": event.host, "status": "unknown", "changed": None, "failed": None, "unreachable": None, "last_task": None, "message": None})
            row["last_task"] = event.task or row["last_task"]
            if event.event_type in ("runner_on_failed", "runner_on_unreachable"):
                row["status"] = "unreachable" if event.event_type == "runner_on_unreachable" else "failed"
                row["message"] = event.message
        if event.event_type == "playbook_on_stats":
            for match in RECAP.finditer(ANSI.sub("", event.message or "")):
                name, ok, changed, unreachable, failed, tail = match.groups()
                counts = dict(ok=int(ok), changed=int(changed), unreachable=int(unreachable), failed=int(failed))
                counts.update({key: int(value) for key, value in re.findall(r"(skipped|rescued|ignored)=(\d+)", tail)})
                recaps[name] = counts

    for name, counts in recaps.items():
        row = hosts.setdefault(name, {"host": name, "last_task": None, "message": None})
        row.update({key: counts[key] for key in ("changed", "failed", "unreachable")})
        row["status"] = "unreachable" if counts["unreachable"] else "failed" if counts["failed"] else "successful"
        # Cancellation does not certify completion, even if a partial recap exists.
        if job.status == "cancelled" and row["status"] == "successful":
            row["status"] = "cancelled"
        if row["status"] == "successful" and (counts.get("ignored", 0) or counts.get("rescued", 0)):
            row["status"] = "warning"

    for row in hosts.values():
        if row["status"] == "unknown" and job.status in ("queued", "running", "cancelled"):
            row["status"] = job.status
    return sorted(hosts.values(), key=lambda row: row["host"])
