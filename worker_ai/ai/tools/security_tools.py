"""
get_security_summary / list_top_vulnerabilities tools for the Security Agent.

Reads directly from the same vulnerabilities/host_vulnerabilities/
container_vulnerabilities tables the Security Intelligence page uses
(app/api/routes/security.py) via a plain sync SessionLocal, same pattern
as patch_tools.py. Prioritization is worker_ai/priority.py, a duplicate of
app/services/priority.py - see that file's docstring for why.
"""
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.models.host import Host
from app.models.vulnerability import ContainerVulnerability, HostVulnerability, Vulnerability
from worker_ai.db import SessionLocal
from worker_ai.priority import compute_priority

SUMMARY_SCHEMA = {
    "name": "get_security_summary",
    "description": (
        "Fleet-wide vulnerability counts: total, critical, high, CISA KEV, fix-available, and "
        "how many hosts/containers are affected. Same aggregate the Security Intelligence page "
        "shows. A quiet fleet legitimately returns real zeros - that is not 'unavailable'."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

TOP_VULNS_SCHEMA = {
    "name": "list_top_vulnerabilities",
    "description": (
        "The highest-priority vulnerabilities currently affecting managed hosts/containers, "
        "ranked by the same severity/CVSS/CISA-KEV/EPSS/host-criticality scoring the Security "
        "Intelligence page's 'What Needs Attention' view uses. Only vulnerabilities that actually "
        "affect something in this fleet, never the raw unfiltered advisory feed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "How many to return, default 10", "default": 10}
        },
        "required": [],
    },
}


def get_security_summary() -> dict:
    with SessionLocal() as db:
        total, critical, high, kev, fixable = db.execute(
            select(
                func.count(Vulnerability.id),
                func.count(Vulnerability.id).filter(Vulnerability.severity == "critical"),
                func.count(Vulnerability.id).filter(Vulnerability.severity == "high"),
                func.count(Vulnerability.id).filter(Vulnerability.cisa_kev.is_(True)),
                func.count(Vulnerability.id).filter(Vulnerability.fixed_version.is_not(None)),
            )
        ).one()
        affected_hosts = db.execute(select(func.count(func.distinct(HostVulnerability.host_id)))).scalar_one()
        affected_containers = db.execute(
            select(func.count(func.distinct(ContainerVulnerability.container_name)))
        ).scalar_one()

        return {
            "available": True,
            "total_vulnerabilities": total,
            "critical": critical,
            "high": high,
            "kev": kev,
            "fix_available": fixable,
            "affected_hosts": affected_hosts,
            "affected_containers": affected_containers,
        }


def list_top_vulnerabilities(limit: int = 10) -> dict:
    with SessionLocal() as db:
        host_criticality = dict(db.execute(select(Host.id, Host.criticality)).all())
        vulns = (
            db.execute(
                select(Vulnerability).options(
                    selectinload(Vulnerability.host_links).selectinload(HostVulnerability.host),
                    selectinload(Vulnerability.container_links),
                )
            )
            .scalars()
            .unique()
            .all()
        )

        ranked = []
        for v in vulns:
            if not v.host_links and not v.container_links:
                continue
            criticalities = [
                host_criticality[link.host_id] for link in v.host_links if link.host_id in host_criticality
            ]
            level, score = compute_priority(
                severity=v.severity,
                cvss_score=v.cvss_score,
                cisa_kev=v.cisa_kev,
                epss_score=v.epss_score,
                fix_available=v.fixed_version is not None,
                affected_host_criticalities=criticalities,
                affected_host_count=len(v.host_links) + len(v.container_links),
            )
            ranked.append((score, level, v))

        ranked.sort(key=lambda r: r[0], reverse=True)
        return {
            "available": True,
            "vulnerabilities": [
                {
                    "cve_id": v.cve_id,
                    "package": v.package_name,
                    "severity": v.severity,
                    "cvss_score": v.cvss_score,
                    "cisa_kev": v.cisa_kev,
                    "fix_available": v.fixed_version is not None,
                    "priority_level": level,
                    "priority_score": score,
                    "affected_hosts": [link.host.hostname for link in v.host_links if link.host],
                }
                for score, level, v in ranked[:limit]
            ],
        }
