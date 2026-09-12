"""One approval, one tracked Ansible job, one immutable expansion request ID."""
import time
import uuid
from sqlalchemy import select
from app.core.disk_expansion import validate_disk_arguments, disk_hostnames, PUBLIC_KEYS
from app.models.host import Host
from app.models.job import AnsibleJob
from worker_ai.db import SessionLocal
from worker_ai.celery_client import get_celery_client

def host_binding(host):
    return {"id": str(host.id), "ip": host.ip_address, "ssh_port": host.ssh_port,
            "ssh_user": host.ssh_user, "credential_id": str(host.credential_id or "")}

def prepare_disk_arguments(db, agent, arguments):
    from worker_ai.ai.runtime import _check_host_allowed
    args = validate_disk_arguments(arguments)
    bindings = {}
    for hostname in disk_hostnames(args):
        denial = _check_host_allowed(agent, db, hostname)
        if denial:
            raise ValueError(denial)
        host = db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none()
        if host is None or host.credential_id is None:
            raise ValueError(f"{hostname}: an existing managed SSH credential is required")
        bindings[hostname] = host_binding(host)
    return {**args, "_disk_hosts": bindings}

def validate_disk_scope(db, agent, arguments):
    public = {key: value for key, value in arguments.items() if key in PUBLIC_KEYS}
    prepared = prepare_disk_arguments(db, agent, public)
    if prepared != arguments:
        raise ValueError("Disk request or managed host identity changed; request a fresh approval")
    return prepared

def execute_expand_disk(arguments):
    args = validate_disk_arguments({k: v for k, v in arguments.items() if k in PUBLIC_KEYS})
    request_id = str(uuid.UUID(arguments["_action_id"]))
    with SessionLocal() as db:
        hosts = []
        for hostname in disk_hostnames(args):
            host = db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none()
            if host is None or host_binding(host) != arguments["_disk_hosts"].get(hostname):
                return {"available": False, "error": "Managed host changed after approval"}
            hosts.append(host)
        variables = {"disk_target_host": args["hostname"], "disk_mount": args["mount"],
                     "disk_add_gib": args["add_gib"], "disk_request_id": request_id, "disk_execute": True}
        if args.get("proxmox_host"):
            variables.update(disk_proxmox_host=args["proxmox_host"], disk_proxmox_vmid=args["vmid"])
        # The action UUID is also the job UUID. Delivery retries cannot create a
        # second relative growth job. Remote journals use the same request ID.
        job = db.get(AnsibleJob, uuid.UUID(request_id))
        if job is None:
            job = AnsibleJob(id=uuid.UUID(request_id), playbook="disk-expand.yml",
                target_description=f"Expand {args['hostname']} {args['mount']} by {args['add_gib']} GiB",
                extra_vars=variables, status="queued")
            db.add(job)
            db.commit()
            get_celery_client().send_task("worker.tasks.run_playbook",
                args=[request_id, [str(h.id) for h in hosts], "disk-expand.yml", None, variables])
        elif job.playbook != "disk-expand.yml" or job.extra_vars != variables:
            return {"available": False, "error": "Existing job does not match approved request", "job_id": request_id}
        for _ in range(900):
            db.refresh(job)
            if job.status in ("successful", "failed", "cancelled"):
                break
            time.sleep(1)
        else:
            return {"available": False, "job_id": request_id, "error":
                "Disk job is still running or its outcome is unknown. Inspect this job; do not request another expansion."}
        payload = job.result_payload or {}
        complete = (payload.get("disk_expansion") or {}).get("completed") is True
        if job.status != "successful" or not complete:
            return {"available": False, "job_id": request_id, "error":
                payload.get("error") or "Disk expansion was not verified complete. Inspect job evidence before retrying; never submit a new growth request blindly.",
                "result": payload}
        return {**payload, "available": True, "job_id": request_id}
