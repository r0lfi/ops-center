import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import require_role
from app.db.session import get_db
from app.models.host import Host
from app.models.job import AnsibleJob
from app.models.security_feed import SecurityAdvisory, SecuritySource
from app.models.vulnerability import ContainerVulnerability, HostVulnerability, Vulnerability
from app.models.container import Container
from app.schemas.job import AnsibleJobRead
from app.schemas.vulnerability import (
    AffectedContainerRead,
    AffectedHostRead,
    SecurityAdvisoryRead,
    SecuritySummary,
    SourceStatus,
    VulnerabilityRead,
)
from app.services.celery_client import get_celery_client
from app.services.priority import compute_priority

router = APIRouter()


def _to_read(
    vuln: Vulnerability,
    host_criticality_by_id: dict[uuid.UUID, str],
    container_lookup_by_name: dict[str, tuple[str, str]],
) -> VulnerabilityRead:
    affected_hosts = [
        AffectedHostRead(id=link.host.id, hostname=link.host.hostname, installed_version=link.installed_version)
        for link in vuln.host_links
        if link.host
    ]
    affected_containers = [
        AffectedContainerRead(
            name=link.container_name,
            hostname=(container_lookup_by_name.get(link.container_name) or (None, None))[0],
            image=(container_lookup_by_name.get(link.container_name) or (None, None))[1],
            installed_version=link.installed_version,
        )
        for link in vuln.container_links
    ]
    criticalities = [
        host_criticality_by_id[link.host_id] for link in vuln.host_links if link.host_id in host_criticality_by_id
    ]
    level, score = compute_priority(
        severity=vuln.severity,
        cvss_score=vuln.cvss_score,
        cisa_kev=vuln.cisa_kev,
        epss_score=vuln.epss_score,
        fix_available=vuln.fix_available,
        affected_host_criticalities=criticalities,
        affected_host_count=len(vuln.host_links) + len(vuln.container_links),
    )
    return VulnerabilityRead(
        id=vuln.id,
        cve_id=vuln.cve_id,
        package_name=vuln.package_name,
        severity=vuln.severity,
        cvss_score=vuln.cvss_score,
        fixed_version=vuln.fixed_version,
        fix_available=vuln.fix_available,
        source=vuln.source,
        cisa_kev=vuln.cisa_kev,
        epss_score=vuln.epss_score,
        first_seen=vuln.first_seen,
        last_seen=vuln.last_seen,
        affected_hosts=affected_hosts,
        affected_containers=affected_containers,
        priority_level=level,
        priority_score=score,
    )


async def _host_criticality_map(db: AsyncSession) -> dict[uuid.UUID, str]:
    result = await db.execute(select(Host.id, Host.criticality))
    return dict(result.all())


async def _container_lookup_map(db: AsyncSession) -> dict[str, tuple[str, str]]:
    # container_vulnerabilities.container_name isn't host-scoped (a
    # pre-existing limitation - see ContainerVulnerability's own
    # docstring) - this is a best-effort name lookup against the
    # containers table, not a real join. A same-named container on two
    # different hosts collides here same as everywhere else this
    # limitation already exists; last one wins. Image is looked up here
    # (not stored on ContainerVulnerability) so the frontend can offer a
    # "check for a newer image" action - patching a container CVE means a
    # new upstream image, not a host package update.
    result = await db.execute(select(Container.name, Container.hostname, Container.image))
    return {name: (hostname, image) for name, hostname, image in result.all()}


async def _submit_bulk_patch_job(db: AsyncSession, host_ids: list[uuid.UUID], target_description: str) -> AnsibleJobRead:
    """One Ansible job across every given host, submitted together - same
    multi-host-single-job pattern host_groups.py's run-now already uses,
    not one job per host. Installs every pending security update on each
    targeted host (patch-security.yml, same as the existing per-host
    action) - not scoped to just the triggering CVE's package, since this
    app has no concept of "patch just this one package"."""
    if not host_ids:
        raise HTTPException(status_code=422, detail="no hosts are currently affected")

    job = AnsibleJob(
        playbook="patch-security.yml",
        target_description=target_description,
        extra_vars={},
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook",
        args=[str(job.id), [str(h) for h in host_ids], "patch-security.yml", None, {}],
    )
    return AnsibleJobRead(
        id=job.id,
        user=job.user,
        playbook=job.playbook,
        target_description=job.target_description,
        limit=job.limit,
        extra_vars=job.extra_vars,
        status=job.status,
        started_at=job.started_at,
        finished_at=job.finished_at,
        changed_hosts=job.changed_hosts,
        successful_hosts=job.successful_hosts,
        failed_hosts=job.failed_hosts,
        unreachable_hosts=job.unreachable_hosts,
        created_at=job.created_at,
        events=[],
    )


async def _host_ids_for_cve_ids(db: AsyncSession, cve_ids: list[str]) -> list[uuid.UUID]:
    if not cve_ids:
        return []
    result = await db.execute(
        select(HostVulnerability.host_id)
        .join(Vulnerability, Vulnerability.id == HostVulnerability.vulnerability_id)
        .where(Vulnerability.cve_id.in_(cve_ids))
        .distinct()
    )
    return [row[0] for row in result.all()]


async def _cve_to_hosts_map(db: AsyncSession, cve_ids: set[str]) -> dict[str, list[AffectedHostRead]]:
    if not cve_ids:
        return {}
    result = await db.execute(
        select(Vulnerability.cve_id, Host.id, Host.hostname, HostVulnerability.installed_version)
        .join(HostVulnerability, HostVulnerability.vulnerability_id == Vulnerability.id)
        .join(Host, Host.id == HostVulnerability.host_id)
        .where(Vulnerability.cve_id.in_(cve_ids))
    )
    mapping: dict[str, list[AffectedHostRead]] = {}
    for cve_id, host_id, hostname, installed_version in result.all():
        mapping.setdefault(cve_id, []).append(
            AffectedHostRead(id=host_id, hostname=hostname, installed_version=installed_version)
        )
    return mapping


@router.post(
    "/security/vulnerabilities/{vulnerability_id}/patch-security",
    response_model=AnsibleJobRead,
    status_code=201,
    dependencies=[Depends(require_role("operator"))],
)
async def patch_security_for_vulnerability(
    vulnerability_id: uuid.UUID, db: AsyncSession = Depends(get_db)
) -> AnsibleJobRead:
    """'Fix it' - patches every host currently affected by this CVE in one
    go, instead of one host at a time."""
    result = await db.execute(
        select(Vulnerability)
        .where(Vulnerability.id == vulnerability_id)
        .options(selectinload(Vulnerability.host_links))
    )
    vuln = result.scalar_one_or_none()
    if vuln is None:
        raise HTTPException(status_code=404, detail="vulnerability not found")
    host_ids = [link.host_id for link in vuln.host_links]
    return await _submit_bulk_patch_job(db, host_ids, f"Fix {vuln.cve_id} - {len(host_ids)} host(s)")


@router.post(
    "/security/advisories/{advisory_id}/patch-security",
    response_model=AnsibleJobRead,
    status_code=201,
    dependencies=[Depends(require_role("operator"))],
)
async def patch_security_for_advisory(advisory_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AnsibleJobRead:
    """Same 'fix it' as vulnerabilities, but for an advisory's whole CVE
    set - resolves every CVE it references against `vulnerabilities`,
    unions the affected hosts, submits one job."""
    advisory = await db.get(SecurityAdvisory, advisory_id)
    if advisory is None:
        raise HTTPException(status_code=404, detail="advisory not found")
    host_ids = await _host_ids_for_cve_ids(db, advisory.cve_ids)
    return await _submit_bulk_patch_job(db, host_ids, f"Fix {advisory.advisory_id} - {len(host_ids)} host(s)")


@router.get("/security/vulnerabilities", response_model=list[VulnerabilityRead])
async def list_vulnerabilities(
    severity: str | None = None,
    kev_only: bool = False,
    fix_available: bool | None = None,
    affected_only: bool = True,
    host_id: uuid.UUID | None = None,
    container_name: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[VulnerabilityRead]:
    query = select(Vulnerability).options(
        selectinload(Vulnerability.host_links).selectinload(HostVulnerability.host),
        selectinload(Vulnerability.container_links),
    )
    if severity is not None:
        query = query.where(Vulnerability.severity == severity)
    if kev_only:
        query = query.where(Vulnerability.cisa_kev.is_(True))
    if fix_available is True:
        query = query.where(Vulnerability.fixed_version.is_not(None))
    elif fix_available is False:
        query = query.where(Vulnerability.fixed_version.is_(None))
    if host_id is not None:
        # Filtered at the query level (not post-hoc in Python) so a host's
        # older CVEs aren't silently dropped by the limit(1000) below on a
        # system with a lot of unrelated vulnerabilities.
        query = query.where(Vulnerability.host_links.any(HostVulnerability.host_id == host_id))
    if container_name is not None:
        # container_vulnerabilities.container_name isn't host-scoped (see
        # _container_lookup_map's docstring above) - a same-named container
        # on two different hosts collides here same as everywhere else.
        query = query.where(
            Vulnerability.container_links.any(ContainerVulnerability.container_name == container_name)
        )

    result = await db.execute(query.order_by(Vulnerability.last_seen.desc()).limit(1000))
    vulns = result.scalars().unique().all()
    host_criticality = await _host_criticality_map(db)
    container_lookup = await _container_lookup_map(db)

    reads = [_to_read(v, host_criticality, container_lookup) for v in vulns]
    if affected_only:
        reads = [r for r in reads if r.affected_hosts or r.affected_containers]
    return reads


@router.get("/security/attention", response_model=list[VulnerabilityRead])
async def what_needs_attention(limit: int = 20, db: AsyncSession = Depends(get_db)) -> list[VulnerabilityRead]:
    """The homelab-relevant subset, ranked by computed priority - never
    just "all CVEs sorted by publication date"."""
    result = await db.execute(
        select(Vulnerability).options(
            selectinload(Vulnerability.host_links).selectinload(HostVulnerability.host),
            selectinload(Vulnerability.container_links),
        )
    )
    vulns = result.scalars().unique().all()
    host_criticality = await _host_criticality_map(db)
    container_lookup = await _container_lookup_map(db)

    reads = [_to_read(v, host_criticality, container_lookup) for v in vulns]
    reads = [r for r in reads if r.affected_hosts or r.affected_containers]
    reads.sort(key=lambda r: r.priority_score, reverse=True)
    return reads[:limit]


@router.get("/security/advisories", response_model=list[SecurityAdvisoryRead])
async def list_advisories(
    kev_only: bool = False,
    severity: str | None = None,
    # Default matches "What Needs Attention"/the vulnerabilities list:
    # only what's relevant to hosts actually in this fleet, not the raw
    # AlmaLinux firehose (400+ advisories, most for packages nobody here
    # runs). affected_only=false is the escape hatch to see everything.
    affected_only: bool = True,
    db: AsyncSession = Depends(get_db),
) -> list[SecurityAdvisoryRead]:
    query = select(SecurityAdvisory)
    if severity is not None:
        query = query.where(SecurityAdvisory.severity == severity)
    result = await db.execute(query.order_by(SecurityAdvisory.published_at.desc()).limit(500))
    advisories = list(result.scalars().all())
    if kev_only:
        # KEV is tracked per-CVE on `vulnerabilities`, not per-advisory - cheap enough to check at this scale.
        kev_rows = await db.execute(select(Vulnerability.cve_id).where(Vulnerability.cisa_kev.is_(True)))
        kev_ids = {row[0] for row in kev_rows}
        advisories = [a for a in advisories if any(c in kev_ids for c in a.cve_ids)]

    # One batched lookup for every advisory's affected hosts, instead of
    # one query per advisory (up to 500 of them here).
    all_cve_ids = {c for a in advisories for c in a.cve_ids}
    cve_to_hosts = await _cve_to_hosts_map(db, all_cve_ids)

    reads = []
    for a in advisories:
        hosts_by_id: dict[uuid.UUID, AffectedHostRead] = {}
        for cve_id in a.cve_ids:
            for h in cve_to_hosts.get(cve_id, []):
                hosts_by_id[h.id] = h  # de-dupe a host affected via more than one of this advisory's CVEs
        reads.append(
            SecurityAdvisoryRead(
                id=a.id,
                source=a.source,
                advisory_id=a.advisory_id,
                title=a.title,
                severity=a.severity,
                published_at=a.published_at,
                cve_ids=a.cve_ids,
                packages=a.packages,
                url=a.url,
                affected_hosts=list(hosts_by_id.values()),
            )
        )
    if affected_only:
        reads = [r for r in reads if r.affected_hosts]
    reads.sort(key=lambda r: len(r.affected_hosts), reverse=True)
    return reads


@router.get("/security/summary", response_model=SecuritySummary)
async def security_summary(db: AsyncSession = Depends(get_db)) -> SecuritySummary:
    since = datetime.now(timezone.utc) - timedelta(hours=24)

    # One round trip for every aggregate over `vulnerabilities` (was 6
    # separate SELECT count(*) queries) via FILTER (WHERE ...) per column.
    vuln_counts = (
        await db.execute(
            select(
                func.count(Vulnerability.id).label("total"),
                func.count(Vulnerability.id).filter(Vulnerability.severity == "critical").label("critical"),
                func.count(Vulnerability.id).filter(Vulnerability.severity == "high").label("high"),
                func.count(Vulnerability.id).filter(Vulnerability.cisa_kev.is_(True)).label("kev"),
                func.count(Vulnerability.id)
                .filter(Vulnerability.fixed_version.is_not(None))
                .label("fixable"),
                func.count(Vulnerability.id)
                .filter(Vulnerability.cisa_kev.is_(True), Vulnerability.first_seen >= since)
                .label("new_kev_entries"),
            )
        )
    ).one()

    affected_hosts = (
        await db.execute(select(func.count(func.distinct(HostVulnerability.host_id))))
    ).scalar_one()
    affected_containers = (
        await db.execute(select(func.count(func.distinct(ContainerVulnerability.container_name))))
    ).scalar_one()
    new_critical_advisories = (
        await db.execute(
            select(func.count(SecurityAdvisory.id)).where(
                SecurityAdvisory.severity == "critical", SecurityAdvisory.first_seen >= since
            )
        )
    ).scalar_one()

    sources_result = await db.execute(select(SecuritySource))
    sources = [
        SourceStatus(
            name=s.name,
            status=s.status,
            last_success_at=s.last_success_at,
            last_error=s.last_error,
            records_last_run=s.records_last_run,
        )
        for s in sources_result.scalars().all()
    ]

    return SecuritySummary(
        total_vulnerabilities=vuln_counts.total,
        critical=vuln_counts.critical,
        high=vuln_counts.high,
        kev=vuln_counts.kev,
        fix_available=vuln_counts.fixable,
        affected_hosts=affected_hosts,
        affected_containers=affected_containers,
        new_critical_advisories=new_critical_advisories,
        new_kev_entries=vuln_counts.new_kev_entries,
        sources=sources,
    )


@router.get("/security")
async def security_root(db: AsyncSession = Depends(get_db)) -> SecuritySummary:
    return await security_summary(db)


@router.post("/hosts/{host_id}/scan", status_code=201, dependencies=[Depends(require_role("operator"))])
async def scan_host(host_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> dict:
    """Submits vulnerability-scan.yml (installed package inventory) for
    this host; results are correlated by security-worker asynchronously."""
    host = await db.get(Host, host_id)
    if host is None:
        raise HTTPException(status_code=404, detail="host not found")

    job = AnsibleJob(
        playbook="vulnerability-scan.yml",
        target_description=f"host:{host_id} ({host.hostname})",
        extra_vars={},
        status="queued",
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_celery_client().send_task(
        "worker.tasks.run_playbook", args=[str(job.id), [str(host_id)], "vulnerability-scan.yml", None, {}]
    )
    return {"job_id": str(job.id)}
