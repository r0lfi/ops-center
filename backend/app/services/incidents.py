"""Incident lifecycle. Database identities survive restarts, severity changes and closure."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from app.models.incidents import IMSettings, Incident, IMCondition, IMEvent, IMDelivery
from app.schemas.incidents import IMConfig

SEVERITY = {"info": 0, "warning": 1, "high": 2, "critical": 3}
FAMILIES = {
    "DiskWarning": ("disk", "disk_capacity"),
    "DiskCritical": ("disk", "disk_capacity"),
    "InodeWarning": ("disk", "disk_capacity"),
    "InodeCritical": ("disk", "disk_capacity"),
    "HighCPU": ("cpu", "cpu"),
    "CriticalCPU": ("cpu", "cpu"),
    "HighMemory": ("memory", "memory"),
    "CriticalMemory": ("memory", "memory"),
    "ServerDown": ("availability", "server_down"),
    "EndpointDown": ("availability", "endpoint_down"),
    "CertificateExpiring": ("certificate", "certificate"),
    "NetworkProbeDataMissing": ("monitoring", "probe_missing"),
}


def utcnow():
    return datetime.now(timezone.utc)


def fingerprint(parts):
    return hashlib.sha256(
        json.dumps(parts, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


async def load_config(db):
    row = await db.get(IMSettings, 1)
    return IMConfig.model_validate(
        {
            **({k: v for k, v in row.value.items() if k != "monitor"} if row else {}),
            "revision": row.revision if row else 0,
        }
    )


def selected(config, item):
    return (
        config.talk_enabled
        and item.category in config.categories
        and item.severity in config.severities
        and item.rule not in config.excluded_rules
        and item.resource not in config.excluded_resources
    )


def resource_candidates(alerts):
    grouped = {}
    for alert in alerts:
        labels = alert.get("labels", {})
        name = labels.get("alertname", "")
        if not name:
            continue
        category, family = FAMILIES.get(name, ("other", name))
        host = (
            labels.get("hostname")
            or labels.get("instance")
            or labels.get("job")
            or "unknown"
        )
        shared = labels.get("fstype") in ("nfs", "nfs4", "cifs")
        if category == "disk":
            identity = (
                [labels.get("device", host)]
                if shared
                else [host, labels.get("mountpoint") or labels.get("device", "")]
            )
        else:
            identity = [
                host,
                labels.get("target", ""),
                labels.get("endpoint", ""),
                labels.get("service", ""),
            ]
        resource = " ".join(str(v) for v in identity if v)[:500]
        key = fingerprint(["alertmanager", family, *identity])
        item = dict(
            fingerprint=key,
            category=category,
            rule=family,
            resource=resource,
            title=("Disk capacity" if category == "disk" else name)[:250],
            severity=(
                labels.get("severity", "warning")
                if labels.get("severity", "warning") in SEVERITY
                else "warning"
            ),
            details={
                "summary": str(alert.get("annotations", {}).get("summary", ""))[:2000],
                "alert": name,
                "silenced": alert.get("status", {}).get("state") == "suppressed",
            },
        )
        if (
            key not in grouped
            or SEVERITY[item["severity"]] > SEVERITY[grouped[key]["severity"]]
        ):
            grouped[key] = item
    return list(grouped.values())


async def reconcile(db, source, candidates, *, now, complete, config, rooms):
    """Caller holds the shared IM transaction lock. Only complete, fresh snapshots prove recovery."""
    conditions = {
        c.fingerprint: c
        for c in (
            await db.scalars(select(IMCondition).where(IMCondition.source == source))
        ).all()
    }
    seen = set()
    for item in candidates:
        key = item["fingerprint"]
        if key in seen:
            continue
        seen.add(key)
        condition = conditions.get(key)
        incident = await db.get(Incident, condition.incident_id) if condition else None
        new_episode = bool(
            incident
            and (incident.status == "completed" or not config.workflow_enabled)
            and condition.healthy_since
            and now - condition.healthy_since
            >= timedelta(minutes=config.recovery_minutes)
            and now - condition.last_checked <= timedelta(seconds=90)
            and complete
        )
        if not incident or new_episode:
            incident = Incident(
                **item,
                status="new",
                source_state="firing",
                observations=1,
                revision=0,
                created_at=now,
                last_seen=now
            )
            db.add(incident)
            await db.flush()
            if condition is None:
                condition = IMCondition(
                    fingerprint=key,
                    source=source,
                    incident_id=incident.id,
                    last_checked=now,
                )
                db.add(condition)
            else:
                condition.incident_id = incident.id
            db.add(
                IMEvent(
                    incident_id=incident.id,
                    actor="monitor",
                    status="new",
                    note=(
                        "New recurrence after confirmed recovery."
                        if new_episode
                        else "First observation."
                    ),
                )
            )
            eligible = (
                selected(config, incident)
                and bool(rooms)
                and not item["details"].get("silenced")
            )
            incident.talk_policy = "queued" if eligible else "muted"
            if eligible:
                db.add_all(
                    [
                        IMDelivery(
                            incident_id=incident.id,
                            room_digest=fingerprint(room),
                            status="pending",
                        )
                        for room in sorted(rooms)
                    ]
                )
        else:
            incident.last_seen = now
            incident.observations += 1
            incident.details = item["details"]
            if SEVERITY[item["severity"]] > SEVERITY[incident.severity]:
                incident.severity = item["severity"]
            incident.source_state = "firing"
        condition.healthy_since = None
        condition.last_checked = now
    for key, condition in conditions.items():
        if key in seen:
            continue
        incident = await db.get(Incident, condition.incident_id)
        if not complete:
            condition.healthy_since = None
            incident.source_state = "unknown"
        else:
            if (
                condition.healthy_since is None
                or now - condition.last_checked > timedelta(seconds=90)
            ):
                condition.healthy_since = now
            incident.source_state = (
                "recovered"
                if now - condition.healthy_since
                >= timedelta(minutes=config.recovery_minutes)
                else "clearing"
            )
            if (
                incident.source_state == "recovered"
                and not config.workflow_enabled
                and incident.status != "completed"
            ):
                incident.status = "completed"
                incident.completed_at = now
                incident.updated_by = "monitor"
                incident.revision += 1
                db.add(
                    IMEvent(
                        incident_id=incident.id,
                        actor="monitor",
                        status="completed",
                        note="Closed automatically after confirmed recovery (IM workflow disabled; notifications only).",
                    )
                )
        condition.last_checked = now


async def decide(db, ident, decision, user):
    from fastapi import HTTPException

    row = await db.get(Incident, ident, with_for_update=True)
    if not row:
        raise HTTPException(404, "IM task not found")
    if row.revision != decision.revision:
        raise HTTPException(409, "This IM changed. Reload before saving.")
    if row.status == "completed":
        raise HTTPException(
            409,
            "Completed IM tasks remain closed. A confirmed new recurrence creates a new IM.",
        )
    allowed = {
        "new": {"approved", "in_progress", "completed"},
        "approved": {"in_progress", "completed"},
        "in_progress": {"completed"},
    }
    if decision.status not in allowed.get(row.status, set()):
        raise HTTPException(409, "Invalid IM status transition")
    row.status = decision.status
    row.revision += 1
    row.updated_by = user.username
    if row.status == "completed":
        row.completed_at = utcnow()
    db.add(
        IMEvent(
            incident_id=row.id,
            actor=user.username,
            status=row.status,
            note=decision.note.strip(),
        )
    )
    return row
