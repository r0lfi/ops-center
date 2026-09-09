"""
Security intelligence feeds. Each fetcher is independent and wrapped so a
failure in one never affects another, and never deletes previously-fetched
data - it just leaves SecuritySource.status reflecting the failure and
keeps whatever was fetched last time.

Deliberately NOT implemented here: Red Hat CSAF (the full corpus is
hundreds of thousands of individual per-advisory JSON documents - a real
sync is a project of its own) and OSV (lower marginal value for this
AlmaLinux-based fleet, since Trivy already correlates container CVEs
directly). See docs/security.md for the reasoning.
"""

from datetime import datetime, timezone

import httpx
from sqlalchemy import select, text

from app.models.security_feed import SecurityAdvisory, SecuritySource
from app.models.vulnerability import Vulnerability

CISA_KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
FIRST_EPSS_URL = "https://api.first.org/data/v1/epss"
ALMALINUX_ERRATA_URL = "https://errata.almalinux.org/10/errata.json"

_SEVERITY_MAP = {
    "critical": "critical",
    "important": "high",
    "moderate": "medium",
    "low": "low",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_or_create_source(db, name: str) -> SecuritySource:
    source = db.execute(select(SecuritySource).where(SecuritySource.name == name)).scalar_one_or_none()
    if source is None:
        source = SecuritySource(name=name)
        db.add(source)
        db.flush()
    return source


def _mark_attempt(db, source: SecuritySource) -> None:
    source.last_attempt_at = _now()
    db.commit()


def _mark_success(db, source: SecuritySource, record_count: int) -> None:
    source.status = "ok"
    source.last_success_at = _now()
    source.last_error = None
    source.records_last_run = record_count
    db.commit()


def _mark_failure(db, source: SecuritySource, error: str) -> None:
    source.status = "error"
    source.last_error = error[:2000]
    db.commit()


def refresh_cisa_kev(db) -> None:
    source = _get_or_create_source(db, "cisa_kev")
    _mark_attempt(db, source)
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(CISA_KEV_URL, follow_redirects=True)
            resp.raise_for_status()
            data = resp.json()

        kev_cve_ids = {v["cveID"] for v in data.get("vulnerabilities", []) if v.get("cveID")}

        db.execute(text("UPDATE vulnerabilities SET cisa_kev = false WHERE cisa_kev = true"))
        if kev_cve_ids:
            db.execute(
                text("UPDATE vulnerabilities SET cisa_kev = true WHERE cve_id = ANY(:ids)"),
                {"ids": list(kev_cve_ids)},
            )
        db.commit()
        _mark_success(db, source, len(kev_cve_ids))
    except Exception as exc:  # noqa: BLE001 - one bad feed must not break the others
        db.rollback()
        _mark_failure(db, source, str(exc))


def refresh_first_epss(db) -> None:
    source = _get_or_create_source(db, "first_epss")
    _mark_attempt(db, source)
    try:
        cve_ids = [row[0] for row in db.execute(select(Vulnerability.cve_id).distinct())]
        if not cve_ids:
            _mark_success(db, source, 0)
            return

        updated = 0
        with httpx.Client(timeout=30.0) as client:
            for i in range(0, len(cve_ids), 100):
                batch = cve_ids[i : i + 100]
                resp = client.get(FIRST_EPSS_URL, params={"cve": ",".join(batch)})
                resp.raise_for_status()
                for entry in resp.json().get("data", []):
                    score = float(entry["epss"])
                    db.execute(
                        text("UPDATE vulnerabilities SET epss_score = :score WHERE cve_id = :cve"),
                        {"score": score, "cve": entry["cve"]},
                    )
                    updated += 1
        db.commit()
        _mark_success(db, source, updated)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _mark_failure(db, source, str(exc))


def refresh_almalinux_errata(db) -> None:
    source = _get_or_create_source(db, "almalinux_errata")
    _mark_attempt(db, source)
    try:
        with httpx.Client(timeout=90.0) as client:
            resp = client.get(ALMALINUX_ERRATA_URL, follow_redirects=True)
            resp.raise_for_status()
            entries = resp.json()

        count = 0
        for entry in entries:
            advisory_id = entry.get("updateinfo_id")
            if not advisory_id:
                continue

            cve_ids = [ref["id"] for ref in entry.get("references", []) if ref.get("type") == "cve"]
            packages = sorted({pkg["name"] for pkg in entry.get("pkglist", {}).get("packages", [])})
            severity = _SEVERITY_MAP.get((entry.get("severity") or "").lower(), "unknown")
            issued = entry.get("issued_date", {}).get("$date")
            published_at = datetime.fromtimestamp(issued / 1000, tz=timezone.utc) if issued else None

            existing = db.execute(
                select(SecurityAdvisory).where(
                    SecurityAdvisory.source == "almalinux", SecurityAdvisory.advisory_id == advisory_id
                )
            ).scalar_one_or_none()
            if existing is None:
                db.add(
                    SecurityAdvisory(
                        source="almalinux",
                        advisory_id=advisory_id,
                        title=entry.get("title"),
                        severity=severity,
                        published_at=published_at,
                        cve_ids=cve_ids,
                        packages=packages,
                        url=f"https://errata.almalinux.org/10/{advisory_id.replace(':', '-')}.html",
                    )
                )
            else:
                existing.title = entry.get("title")
                existing.severity = severity
                existing.cve_ids = cve_ids
                existing.packages = packages
                existing.last_seen = _now()
            count += 1

        db.commit()
        _mark_success(db, source, count)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _mark_failure(db, source, str(exc))
