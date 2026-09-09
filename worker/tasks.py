import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone

import ansible_runner
import yaml
from sqlalchemy import select

from app.models.container import Container
from app.models.host import Host, HostOnboardingStep
from app.models.job import AnsibleEvent, AnsibleJob
from app.models.patch import Patch, PatchScan
from app.models.vulnerability import HostVulnerability, Vulnerability
from worker.celery_app import celery_app
from worker.db import SessionLocal
from worker.inventory import build_inventory
from worker.patch_parser import parse_patch_check
from worker.redis_client import get_redis_client

PATCH_MARKER = "OPS_CENTER_PATCH_CHECK:"
VULN_MARKER = "OPS_CENTER_VULN_SCAN:"
CONTAINERS_MARKER = "OPS_CENTER_CONTAINERS:"
# Generic result passthrough, unlike the markers above: any playbook can opt
# in just by emitting this once, no per-playbook branch needed here - see
# the query_result_payloads handling below and AnsibleJob.result_payload.
QUERY_MARKER = "OPS_CENTER_QUERY_RESULT:"

ANSIBLE_PROJECT_DIR = os.environ.get("ANSIBLE_PROJECT_DIR", "/app/ansible")
redis_client = get_redis_client()

# Extra-vars whose *value* is arbitrary content that may itself contain
# literal Jinja-like text (docker --format '{{.State.Status}}', curl
# headers with ": ", etc) - run-shell-command.yml / container-exec.yml.
# Passed as a normal Python dict, ansible-runner would serialize these to
# plain JSON, and Ansible then re-templates the *substituted* value if it
# still looks like a template ('unexpected '.'' errors on Go-template
# syntax) - this isn't fixable from the playbook side (verified: dict-arg
# form, set_fact, list-wrapping all still fail identically, because the
# recursion triggers on the rendered *output* looking templatable, not on
# how the source expression was written). The actual fix is Ansible's
# `!unsafe` YAML tag, which only the YAML loader can attach - so these
# specific keys are written to their own small `!unsafe`-tagged vars file
# and loaded via -e @file instead of going through the extravars dict.
_UNSAFE_EXTRAVAR_KEYS = {"shell_command", "container_command"}


def _unsafe_vars_yaml(key: str, value: str) -> str:
    dumped = yaml.safe_dump({key: value}, default_flow_style=False, allow_unicode=True, default_style='"')
    return re.sub(rf'^"?{re.escape(key)}"?:\s*', f"{key}: !unsafe ", dumped, count=1)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _publish(job_id: str, payload: dict) -> None:
    try:
        redis_client.publish(f"ansible_job:{job_id}", json.dumps(payload, default=str))
    except Exception:
        pass  # pubsub is best-effort live streaming; Postgres remains the source of truth


def _cancel_requested(job_id: str) -> bool:
    try:
        return redis_client.exists(f"ansible_job:{job_id}:cancel") == 1
    except Exception:
        return False


def _update_onboarding_steps(
    db, onboarding: dict, host_stats: dict[str, dict], job_status: str, detail: str | None = None
) -> None:
    hostname = onboarding.get("hostname")
    stats = host_stats.get(hostname, {}) if hostname else {}
    host_ok = job_status == "successful" and stats.get("failures", 0) == 0 and stats.get("unreachable", 0) == 0
    status = "ok" if host_ok else "failed"
    message = detail or f"ansible job status: {job_status}"

    for step_name in onboarding.get("steps", []):
        row = db.execute(
            select(HostOnboardingStep).where(
                HostOnboardingStep.host_id == onboarding["host_id"], HostOnboardingStep.step == step_name
            )
        ).scalar_one_or_none()
        if row is None:
            row = HostOnboardingStep(host_id=onboarding["host_id"], step=step_name)
            db.add(row)
        row.status = status
        row.detail = message
        row.finished_at = _now()
    db.commit()


def _store_patch_scan_results(db, job: AnsibleJob, hosts: list[Host], payloads: dict[str, dict]) -> None:
    by_hostname = {h.hostname: h for h in hosts}
    for hostname, payload in payloads.items():
        host = by_hostname.get(hostname)
        if host is None:
            continue
        records, reboot_required = parse_patch_check(payload)
        scan = PatchScan(
            host_id=host.id,
            ansible_job_id=job.id,
            status="completed",
            pending_count=len(records),
            pending_security_count=sum(1 for r in records if r["is_security"]),
            reboot_required=reboot_required,
            started_at=job.started_at,
            completed_at=_now(),
        )
        db.add(scan)
        db.flush()
        for record in records:
            db.add(Patch(patch_scan_id=scan.id, host_id=host.id, **record))
            for cve_id in record.get("cve_ids") or []:
                _upsert_advisory_vulnerability(db, host, cve_id, record)
        host.reboot_required = reboot_required
    db.commit()


def _upsert_advisory_vulnerability(db, host: Host, cve_id: str, patch_record: dict) -> None:
    """
    Real CVE-level correlation sourced from the distro's own security
    advisories (dnf updateinfo) - more accurate for AlmaLinux/RHEL hosts
    than generic third-party detection, and reuses the exact same advisory
    data patch-check.yml already collects. Trivy (via security-worker)
    covers what this can't: container images, and non-advisory findings.
    """
    vuln = db.execute(
        select(Vulnerability).where(
            Vulnerability.cve_id == cve_id, Vulnerability.package_name == patch_record["package_name"]
        )
    ).scalar_one_or_none()
    if vuln is None:
        vuln = Vulnerability(
            cve_id=cve_id,
            package_name=patch_record["package_name"],
            severity=patch_record.get("severity", "unknown"),
            fixed_version=patch_record.get("fixed_version"),
            source="dnf-updateinfo",
        )
        db.add(vuln)
        db.flush()
    else:
        vuln.severity = patch_record.get("severity", vuln.severity)
        vuln.fixed_version = patch_record.get("fixed_version") or vuln.fixed_version
        vuln.last_seen = _now()

    link = db.execute(
        select(HostVulnerability).where(
            HostVulnerability.host_id == host.id, HostVulnerability.vulnerability_id == vuln.id
        )
    ).scalar_one_or_none()
    if link is None:
        db.add(HostVulnerability(host_id=host.id, vulnerability_id=vuln.id))
    else:
        link.last_seen = _now()


def _dispatch_sbom_scans(hosts: list[Host], payloads: dict[str, dict]) -> None:
    """Hands each host's installed-package inventory to security-worker
    (Trivy) for correlation - this worker never runs Trivy itself, keeping
    Docker-socket access isolated to that one component."""
    by_hostname = {h.hostname: h for h in hosts}
    for hostname, payload in payloads.items():
        host = by_hostname.get(hostname)
        if host is None:
            continue
        packages = []
        for line in payload.get("packages_tsv") or []:
            fields = line.split("\t")
            if len(fields) != 3:
                continue
            name, version, arch = fields
            packages.append({"name": name, "version": version, "arch": arch})
        celery_app.send_task(
            "security.tasks.scan_host_sbom",
            args=[str(host.id), payload.get("distro", ""), packages],
            queue="security",
        )


def _store_container_inventory(db, payloads: dict[str, dict]) -> None:
    """
    Upserts container-inventory.yml's raw `docker inspect` JSON lines into
    the shared `containers` table, scoped to each reporting hostname -
    ops-host itself is never touched here (it's synced separately by
    security-worker over docker.sock; this only ever runs against other
    hosts, since ops-host has no reason to SSH to itself for this).
    Stale rows are cleaned up per-hostname, same logic as
    security/tasks.py's sync_container_status, just scoped to one host at
    a time instead of the whole table.
    """
    for hostname, payload in payloads.items():
        seen_names: set[str] = set()
        for line in payload.get("containers") or []:
            try:
                inspect = json.loads(line)
            except (ValueError, TypeError):
                continue

            name = (inspect.get("Name") or "").lstrip("/")
            if not name:
                continue
            state = inspect.get("State") or {}
            health = (state.get("Health") or {}).get("Status")
            seen_names.add(name)

            row = db.execute(
                select(Container).where(Container.hostname == hostname, Container.name == name)
            ).scalar_one_or_none()
            if row is None:
                row = Container(hostname=hostname, name=name)
                db.add(row)
            row.image = ((inspect.get("Config") or {}).get("Image")) or "unknown"
            row.status = state.get("Status") or "unknown"
            row.health = health
            row.restart_count = inspect.get("RestartCount") or 0
            row.last_seen = _now()

        if seen_names:
            stale = db.execute(
                select(Container).where(Container.hostname == hostname, Container.name.not_in(seen_names))
            ).scalars().all()
            for row in stale:
                db.delete(row)
        db.commit()


def _enqueue_followup_patch_check(db, parent_job_id: str, hosts: list[Host]) -> None:
    """After installing patches, automatically refresh the pending-patch
    state rather than leaving stale counts until the next nightly scan."""
    job = AnsibleJob(
        playbook="patch-check.yml",
        target_description=f"post-install refresh (after job {parent_job_id})",
        extra_vars={},
        status="queued",
    )
    db.add(job)
    db.commit()
    run_playbook.delay(str(job.id), [str(h.id) for h in hosts], "patch-check.yml", None, {})


@celery_app.task(bind=True, name="worker.tasks.run_playbook")
def run_playbook(
    self,
    job_id: str,
    host_ids: list[str],
    playbook: str,
    limit: str | None,
    extra_vars: dict,
    onboarding: dict | None = None,
) -> None:
    """
    `onboarding`, when given, is {"host_id": str, "hostname": str, "steps": [str, ...]}:
    the calling host's onboarding steps to mark ok/failed based on whether
    that specific host succeeded in this run - used when a job was submitted
    on behalf of the Add Server workflow rather than an operator-initiated
    Automation run.
    """
    db = SessionLocal()
    sequence = 0
    host_stats: dict[str, dict] = {}
    patch_check_payloads: dict[str, dict] = {}
    vuln_scan_payloads: dict[str, dict] = {}
    container_inventory_payloads: dict[str, dict] = {}
    query_result_payloads: dict[str, dict] = {}

    def record_event(event: dict) -> None:
        nonlocal sequence
        sequence += 1
        event_type = event.get("event", "unknown")
        event_data = event.get("event_data") or {}
        host = event_data.get("host")
        task_name = event_data.get("task")
        res = event_data.get("res") if isinstance(event_data.get("res"), dict) else {}
        raw_message = res.get("msg") or event.get("stdout") or event_type
        # `debug: msg=` can be a dict/list (e.g. health-check.yml's summary) -
        # the column is text, so anything non-string is serialized as JSON.
        message = raw_message if isinstance(raw_message, str) else json.dumps(raw_message, default=str)

        try:
            db.add(
                AnsibleEvent(
                    job_id=job_id, sequence=sequence, event_type=event_type, host=host, task=task_name, message=message
                )
            )
            db.commit()
        except Exception:
            # A single malformed event must never take down the rest of the
            # job's event stream or leave the session unusable.
            db.rollback()

        _publish(
            job_id,
            {"sequence": sequence, "event_type": event_type, "host": host, "task": task_name, "message": message},
        )

        if event_type == "runner_on_ok" and task_name == "Gathering Facts" and host:
            facts = res.get("ansible_facts") or {}
            distro = facts.get("ansible_distribution")
            if distro:
                host_row = db.execute(select(Host).where(Host.hostname == host)).scalar_one_or_none()
                if host_row is not None:
                    host_row.operating_system = distro
                    host_row.os_version = facts.get("ansible_distribution_version")
                    db.commit()

        if event_type == "runner_on_ok" and task_name == "Report reboot status" and host and isinstance(message, str):
            if "reboot_required=True" in message or "reboot_required=False" in message:
                host_row = db.execute(select(Host).where(Host.hostname == host)).scalar_one_or_none()
                if host_row is not None:
                    host_row.reboot_required = "reboot_required=True" in message
                    db.commit()

        if event_type == "runner_on_ok" and host and isinstance(message, str) and message.startswith(PATCH_MARKER):
            try:
                patch_check_payloads[host] = json.loads(message[len(PATCH_MARKER):])
            except (ValueError, TypeError):
                pass

        if event_type == "runner_on_ok" and host and isinstance(message, str) and message.startswith(VULN_MARKER):
            try:
                vuln_scan_payloads[host] = json.loads(message[len(VULN_MARKER):])
            except (ValueError, TypeError):
                pass

        if event_type == "runner_on_ok" and host and isinstance(message, str) and message.startswith(CONTAINERS_MARKER):
            try:
                container_inventory_payloads[host] = json.loads(message[len(CONTAINERS_MARKER):])
            except (ValueError, TypeError):
                pass

        if event_type == "runner_on_ok" and host and isinstance(message, str) and message.startswith(QUERY_MARKER):
            try:
                query_result_payloads[host] = json.loads(message[len(QUERY_MARKER):])
            except (ValueError, TypeError):
                pass

        if event_type == "playbook_on_stats":
            # event_data here IS the PLAY RECAP: {"ok": {host: n}, "changed": {host: n},
            # "dark": {host: n}, "failures": {host: n}, ...} - category -> hostname -> count.
            # Reshaped below into {hostname: {changed, unreachable, failures}} for easy lookup.
            for host_name in {
                *(event_data.get("ok") or {}),
                *(event_data.get("changed") or {}),
                *(event_data.get("dark") or {}),
                *(event_data.get("failures") or {}),
            }:
                host_stats[host_name] = {
                    "changed": (event_data.get("changed") or {}).get(host_name, 0),
                    "unreachable": (event_data.get("dark") or {}).get(host_name, 0),
                    "failures": (event_data.get("failures") or {}).get(host_name, 0),
                }

    job = db.execute(select(AnsibleJob).where(AnsibleJob.id == job_id)).scalar_one()
    job.status = "running"
    job.celery_task_id = self.request.id
    job.started_at = _now()
    db.commit()

    hosts = db.execute(select(Host).where(Host.id.in_(host_ids))).scalars().all()
    inventory = build_inventory(hosts)

    private_data_dir = tempfile.mkdtemp(prefix="ops-center-job-")
    try:
        safe_extra_vars = dict(extra_vars)
        cmdline_parts = []
        for key in _UNSAFE_EXTRAVAR_KEYS & safe_extra_vars.keys():
            unsafe_path = os.path.join(private_data_dir, f"unsafe_{key}.yml")
            with open(unsafe_path, "w") as f:
                f.write(_unsafe_vars_yaml(key, safe_extra_vars.pop(key)))
            cmdline_parts.append(f"-e @{unsafe_path}")

        runner = ansible_runner.run(
            private_data_dir=private_data_dir,
            project_dir=ANSIBLE_PROJECT_DIR,
            playbook=playbook,
            inventory=inventory,
            limit=limit,
            extravars=safe_extra_vars,
            cmdline=" ".join(cmdline_parts) or None,
            event_handler=record_event,
            cancel_callback=lambda: _cancel_requested(job_id),
            quiet=True,
            # install-alloy.yml reads LOKI_EXTERNAL_URL via lookup('env', ...)
            # for its loki_url default - explicit envvars rather than relying
            # on ansible-runner's subprocess env inheritance.
            envvars={"LOKI_EXTERNAL_URL": os.environ.get("LOKI_EXTERNAL_URL", "")},
        )

        # host_stats: {hostname: {ok, changed, unreachable, failures, skipped, ...}}
        job.changed_hosts = sum(1 for s in host_stats.values() if s.get("changed", 0) > 0)
        job.unreachable_hosts = sum(1 for s in host_stats.values() if s.get("unreachable", 0) > 0)
        job.failed_hosts = sum(1 for s in host_stats.values() if s.get("failures", 0) > 0)
        job.successful_hosts = sum(
            1 for s in host_stats.values() if s.get("unreachable", 0) == 0 and s.get("failures", 0) == 0
        )

        if runner.status == "canceled":
            job.status = "cancelled"
        elif runner.status == "successful":
            job.status = "successful"
        else:
            job.status = "failed"

        unreachable_hostnames = {h for h, s in host_stats.items() if s.get("unreachable", 0) > 0}
        now = _now()
        for host in hosts:
            host.last_ansible_run = now
            if host.hostname not in unreachable_hostnames:
                host.last_seen = now
        db.commit()

        if query_result_payloads:
            # One-shot query playbooks (docker-images.yml etc.) target
            # exactly one host per job (see containers.py's _run_remote_query),
            # so there's at most one value here regardless of playbook.
            job.result_payload = next(iter(query_result_payloads.values()), None)
            db.commit()

        if onboarding:
            _update_onboarding_steps(db, onboarding, host_stats, job.status)

        if playbook == "patch-check.yml" and patch_check_payloads:
            _store_patch_scan_results(db, job, hosts, patch_check_payloads)

        if playbook in ("patch-security.yml", "patch-all.yml") and job.status == "successful":
            _enqueue_followup_patch_check(db, job_id, hosts)

        if playbook == "vulnerability-scan.yml" and vuln_scan_payloads:
            _dispatch_sbom_scans(hosts, vuln_scan_payloads)

        if playbook == "container-inventory.yml":
            _store_container_inventory(db, container_inventory_payloads)

    except Exception as exc:  # noqa: BLE001 - job must be marked failed no matter what breaks
        db.rollback()  # clear any failed-flush state before writing the failure itself
        job.status = "failed"
        record_event({"event": "job_exception", "event_data": {}, "stdout": str(exc)})
        if onboarding:
            _update_onboarding_steps(db, onboarding, {}, "failed", detail=str(exc))
    finally:
        job.finished_at = _now()
        db.commit()
        shutil.rmtree(private_data_dir, ignore_errors=True)
        redis_client.delete(f"ansible_job:{job_id}:cancel")
        _publish(job_id, {"event_type": "job_complete", "status": job.status})
        db.close()
