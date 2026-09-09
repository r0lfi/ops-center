"""
get_patch_status tool.

Reads the same patch_scans/patches rows the existing Patching page shows
(app/api/routes/patching.py's GET /hosts/{id}/patches) - the latest scan
already collected for a host, not a fresh live check. Patch scans are a
deliberately separate, occasionally slow operation (a real yum/apt
metadata refresh) that the app already runs on a schedule and via an
explicit "Check now" button - reusing that stored result here rather than
triggering a brand new scan per question, matching how get_alerts/
get_server_metrics also read already-collected data instead of probing
live. The response always says how old the data is, so the agent can be
honest about staleness instead of implying it just checked.
"""
from sqlalchemy import select

from app.models.host import Host
from app.models.patch import Patch, PatchScan
from worker_ai.db import SessionLocal

_MAX_PACKAGES_TO_MODEL = 30

TOOL_SCHEMA = {
    "name": "get_patch_status",
    "description": (
        "The most recent patch/update scan already recorded for one managed host: pending "
        "update count, pending security-update count, whether a reboot is required, and the "
        "list of pending packages. This is the last scan the app has on file, not a fresh check - "
        "the response includes when it ran. Returns available=false if no scan has ever been run "
        "for this host - never guess at patch state in that case, say a scan needs to be run first."
    ),
    "parameters": {
        "type": "object",
        "properties": {"hostname": {"type": "string"}},
        "required": ["hostname"],
    },
}


LIST_PENDING_PATCHES_SCHEMA = {
    "name": "list_pending_patches",
    "description": (
        "Pending OS packages across every managed host's most recent patch scan (fleet-wide, not "
        "one host) - optionally filtered to security updates only. Same data as the Patching "
        "page's table."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "security_only": {
                "type": "boolean",
                "description": "Only security updates, default false",
                "default": False,
            }
        },
        "required": [],
    },
}


def get_patch_status(hostname: str) -> dict:
    with SessionLocal() as db:
        host = db.execute(select(Host).where(Host.hostname == hostname)).scalar_one_or_none()
        if host is None:
            return {"available": False, "error": f"no managed host named {hostname!r}"}

        scan = db.execute(
            select(PatchScan)
            .where(PatchScan.host_id == host.id)
            .order_by(PatchScan.created_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if scan is None:
            return {
                "available": False,
                "error": f"no patch scan has ever been run for {hostname!r} - run one from the Patching page first",
            }

        patches = db.execute(select(Patch).where(Patch.patch_scan_id == scan.id)).scalars().all()

        return {
            "available": True,
            "hostname": hostname,
            "scan_status": scan.status,
            "scanned_at": scan.created_at.isoformat() if scan.created_at else None,
            "pending_count": scan.pending_count,
            "pending_security_count": scan.pending_security_count,
            "reboot_required": scan.reboot_required,
            "packages": [
                {
                    "package": p.package_name,
                    "installed_version": p.installed_version,
                    "fixed_version": p.fixed_version,
                    "security": p.is_security,
                    "severity": p.severity,
                    "cves": p.cve_ids,
                }
                for p in patches[:_MAX_PACKAGES_TO_MODEL]
            ],
        }


def list_pending_patches(security_only: bool = False) -> dict:
    latest_scan_ids = (
        select(PatchScan.host_id, PatchScan.id.label("scan_id"))
        .order_by(PatchScan.host_id, PatchScan.created_at.desc())
        .distinct(PatchScan.host_id)
    ).subquery()

    with SessionLocal() as db:
        query = (
            select(Patch, Host.hostname)
            .join(PatchScan, PatchScan.id == Patch.patch_scan_id)
            .join(Host, Host.id == PatchScan.host_id)
            .where(Patch.patch_scan_id.in_(select(latest_scan_ids.c.scan_id)))
        )
        if security_only:
            query = query.where(Patch.is_security.is_(True))
        rows = db.execute(query.order_by(Host.hostname, Patch.package_name).limit(_MAX_PACKAGES_TO_MODEL * 4)).all()

        return {
            "available": True,
            "patches": [
                {
                    "hostname": hostname,
                    "package": p.package_name,
                    "installed_version": p.installed_version,
                    "fixed_version": p.fixed_version,
                    "security": p.is_security,
                    "severity": p.severity,
                }
                for p, hostname in rows
            ],
        }
