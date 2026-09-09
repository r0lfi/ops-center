"""Parses `dockle --format json` output and upserts into
image_lint_findings - see app/models/image_findings.py for why dockle's
CIS-Docker-Benchmark findings don't live in the Vulnerability table."""

from datetime import datetime, timezone

from sqlalchemy import select

from app.models.image_findings import ImageLintFinding


def _now() -> datetime:
    return datetime.now(timezone.utc)


def iter_findings(dockle_report: dict):
    for detail in dockle_report.get("details") or []:
        yield detail


def upsert_lint_finding(db, container_name: str, image: str, finding: dict) -> ImageLintFinding:
    code = finding.get("code", "UNKNOWN")
    level = finding.get("level", "INFO")
    title = finding.get("title", "")
    alerts = finding.get("alerts") or []

    existing = db.execute(
        select(ImageLintFinding).where(
            ImageLintFinding.container_name == container_name, ImageLintFinding.code == code
        )
    ).scalar_one_or_none()

    if existing is None:
        existing = ImageLintFinding(
            container_name=container_name, image=image, code=code, level=level, title=title, alerts=alerts
        )
        db.add(existing)
        db.flush()
    else:
        existing.image = image
        existing.level = level
        existing.title = title
        existing.alerts = alerts
        existing.last_seen = _now()

    return existing
