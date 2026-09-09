"""Parses `trufflehog docker --json` NDJSON output (one finding per line)
and upserts into secret_findings. Deliberately reads only `Redacted`,
`DetectorName` and `Verified` from each line - never `Raw` (the actual
secret value) - see app/models/image_findings.py."""

import json
from datetime import datetime, timezone

from sqlalchemy import select

from app.models.image_findings import SecretFinding


def _now() -> datetime:
    return datetime.now(timezone.utc)


def iter_findings(raw_output: str):
    for line in raw_output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def upsert_secret_finding(db, container_name: str, image: str, finding: dict) -> SecretFinding:
    docker_meta = ((finding.get("SourceMetadata") or {}).get("Data") or {}).get("Docker") or {}
    detector_name = finding.get("DetectorName", "unknown")
    redacted = finding.get("Redacted", "")
    file_path = docker_meta.get("File")
    layer_digest = docker_meta.get("Layer")

    existing = db.execute(
        select(SecretFinding).where(
            SecretFinding.container_name == container_name,
            SecretFinding.detector_name == detector_name,
            SecretFinding.file_path == file_path,
            SecretFinding.redacted == redacted,
        )
    ).scalar_one_or_none()

    if existing is None:
        existing = SecretFinding(
            container_name=container_name,
            image=image,
            detector_name=detector_name,
            verified=bool(finding.get("Verified")),
            redacted=redacted,
            file_path=file_path,
            layer_digest=layer_digest,
        )
        db.add(existing)
        db.flush()
    else:
        existing.image = image
        existing.verified = bool(finding.get("Verified"))
        existing.last_seen = _now()

    return existing
