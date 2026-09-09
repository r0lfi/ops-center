import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.host import Host, HostOnboardingStep
from app.models.job import AnsibleJob
from app.services import connectivity
from app.services.celery_client import get_celery_client
from app.services.prometheus_sd import write_node_exporter_targets

# Steps resolved by the install-node-exporter.yml onboarding job (it also
# gathers facts, so one job covers all three).
_MONITORING_JOB_STEPS = ["gather_facts", "detect_os", "deploy_monitoring"]

# baseline_patch_scan/baseline_vuln_scan used to be hardcoded "blocked -
# Phase 6/7 doesn't exist yet" placeholders. Both phases have since landed
# (patch-check.yml + vulnerability-scan.yml), so these now submit real jobs
# the same way the monitoring steps above do - one playbook, one step, each.
_BASELINE_SCAN_JOBS: dict[str, str] = {
    "baseline_patch_scan": "patch-check.yml",
    "baseline_vuln_scan": "vulnerability-scan.yml",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _set_step(db: AsyncSession, host_id: uuid.UUID, step: str, status: str, detail: str) -> None:
    result = await db.execute(
        select(HostOnboardingStep).where(
            HostOnboardingStep.host_id == host_id, HostOnboardingStep.step == step
        )
    )
    row = result.scalar_one_or_none()
    now = _now()
    if row is None:
        row = HostOnboardingStep(host_id=host_id, step=step, status=status, detail=detail)
        if status == "running":
            row.started_at = now
        if status in ("ok", "failed", "blocked"):
            row.finished_at = now
        db.add(row)
    else:
        row.status = status
        row.detail = detail
        if status == "running":
            row.started_at = now
        if status in ("ok", "failed", "blocked"):
            row.finished_at = now
    await db.flush()


async def run_onboarding(db: AsyncSession, host: Host) -> None:
    """
    Runs the full onboarding pipeline: network + SSH reachability, host key
    fingerprint, Prometheus service discovery registration, and (via
    submitted Ansible jobs, never run in-process here) node_exporter
    deployment + fact gathering + baseline patch/vulnerability scans.

    Safe to call again (e.g. from the Retry button).
    """
    await _set_step(db, host.id, "verify_network", "running", "checking TCP reachability")
    network_ok, network_detail = await connectivity.check_tcp(host.ip_address, host.ssh_port)
    await _set_step(db, host.id, "verify_network", "ok" if network_ok else "failed", network_detail)

    ssh_ok = False
    if not network_ok:
        await _set_step(db, host.id, "verify_ssh", "blocked", "host is not network-reachable")
        await _set_step(db, host.id, "record_fingerprint", "blocked", "requires successful SSH authentication")
    else:
        await _set_step(db, host.id, "verify_ssh", "running", "attempting SSH authentication")
        ssh_ok, ssh_detail, fingerprint = await connectivity.check_ssh(
            host.ip_address,
            host.ssh_port,
            host.ssh_user,
            host.credential,
            expected_fingerprint=host.ssh_host_fingerprint,
        )
        await _set_step(db, host.id, "verify_ssh", "ok" if ssh_ok else "failed", ssh_detail)

        if ssh_ok and fingerprint:
            host.ssh_host_fingerprint = fingerprint
            host.last_seen = _now()
            await _set_step(db, host.id, "record_fingerprint", "ok", fingerprint)
        else:
            await _set_step(
                db,
                host.id,
                "record_fingerprint",
                "blocked",
                "requires successful SSH authentication (see verify_ssh)",
            )

    # Prometheus service discovery: purely local (DB -> file), no Ansible
    # needed, so this can complete synchronously and for real right now.
    all_hosts = (await db.execute(select(Host))).scalars().all()
    write_node_exporter_targets(list(all_hosts))
    await _set_step(
        db,
        host.id,
        "prometheus_sd",
        "ok",
        "registered in the node_exporter file_sd target file (target will read 'down' until node_exporter is deployed)",
    )

    if ssh_ok:
        for step in _MONITORING_JOB_STEPS:
            await _set_step(db, host.id, step, "running", "submitted install-node-exporter.yml")

        job = AnsibleJob(
            playbook="install-node-exporter.yml",
            target_description=f"onboarding:{host.hostname}",
            extra_vars={},
            status="queued",
        )
        db.add(job)
        # Committed (not just flushed) before dispatch: the worker uses its
        # own DB connection and may pick the task up before this
        # transaction would otherwise commit, and fail to find the row.
        await db.commit()

        celery = get_celery_client()
        celery.send_task(
            "worker.tasks.run_playbook",
            args=[str(job.id), [str(host.id)], "install-node-exporter.yml", None, {}],
            kwargs={"onboarding": {"host_id": str(host.id), "hostname": host.hostname, "steps": _MONITORING_JOB_STEPS}},
        )
        for step, playbook in _BASELINE_SCAN_JOBS.items():
            await _set_step(db, host.id, step, "running", f"submitted {playbook}")

            scan_job = AnsibleJob(
                playbook=playbook,
                target_description=f"onboarding:{host.hostname}",
                extra_vars={},
                status="queued",
            )
            db.add(scan_job)
            await db.commit()

            celery.send_task(
                "worker.tasks.run_playbook",
                args=[str(scan_job.id), [str(host.id)], playbook, None, {}],
                kwargs={"onboarding": {"host_id": str(host.id), "hostname": host.hostname, "steps": [step]}},
            )
    else:
        for step in _MONITORING_JOB_STEPS:
            await _set_step(db, host.id, step, "blocked", "requires successful SSH authentication (see verify_ssh)")
        for step in _BASELINE_SCAN_JOBS:
            await _set_step(db, host.id, step, "blocked", "requires successful SSH authentication (see verify_ssh)")

    await db.commit()
