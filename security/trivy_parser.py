"""Parses `trivy ... --format json` output and upserts findings into the
vulnerabilities catalog (see app/models/vulnerability.py for the schema
rationale)."""

from datetime import datetime, timezone

from sqlalchemy import select

from app.models.vulnerability import Vulnerability

_SEVERITY_MAP = {
    "CRITICAL": "critical",
    "HIGH": "high",
    "MEDIUM": "medium",
    "LOW": "low",
    "UNKNOWN": "unknown",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def iter_findings(trivy_report: dict):
    for result in trivy_report.get("Results") or []:
        for vuln in result.get("Vulnerabilities") or []:
            yield vuln


def _extract_cvss(vuln: dict) -> float | None:
    cvss = vuln.get("CVSS") or {}
    for source in ("nvd", "redhat", "ghsa"):
        score = (cvss.get(source) or {}).get("V3Score")
        if score is not None:
            return float(score)
    return None


def upsert_vulnerability(db, vuln: dict) -> Vulnerability:
    cve_id = vuln.get("VulnerabilityID", "UNKNOWN")
    package_name = vuln.get("PkgName", "unknown")

    existing = db.execute(
        select(Vulnerability).where(Vulnerability.cve_id == cve_id, Vulnerability.package_name == package_name)
    ).scalar_one_or_none()

    severity = _SEVERITY_MAP.get((vuln.get("Severity") or "UNKNOWN").upper(), "unknown")
    fixed_version = vuln.get("FixedVersion") or None
    cvss_score = _extract_cvss(vuln)
    references = (vuln.get("References") or [])[:20]
    description = vuln.get("Description")

    if existing is None:
        existing = Vulnerability(
            cve_id=cve_id,
            package_name=package_name,
            severity=severity,
            cvss_score=cvss_score,
            fixed_version=fixed_version,
            source="trivy",
            description=description,
            references=references,
        )
        db.add(existing)
        db.flush()
    else:
        # Keep first_seen; refresh everything else in case Trivy's DB
        # updated severity/fix info since we last saw this pair. Each
        # field falls back to the existing value rather than overwriting
        # unconditionally, so a partial/degraded scan result (Trivy DB
        # mid-sync, a truncated response) can't silently downgrade a
        # previously-known severity/score/fix to unknown/None - it just
        # leaves the last good value in place until a real update arrives.
        existing.severity = severity if severity != "unknown" else existing.severity
        existing.cvss_score = cvss_score if cvss_score is not None else existing.cvss_score
        existing.fixed_version = fixed_version or existing.fixed_version
        existing.description = description or existing.description
        existing.references = references or existing.references
        existing.last_seen = _now()

    return existing
