"""Trusted incident ownership and revocation checks shared by API and workers."""
from datetime import datetime, timezone, timedelta
from sqlalchemy import select
from app.models.ai import AIAgent, AIProvider
from app.models.incidents import Incident, IMInvestigation, IMSettings
from app.models.user import User


def incident_task_authorized(db, task):
    if task.source != "incident" or not task.owner_user_id:
        return False
    link = db.scalar(select(IMInvestigation).where(IMInvestigation.task_id == task.id))
    settings = db.get(IMSettings, 1, populate_existing=True)
    config = settings.value if settings else {}
    if not link or not config.get("auto_investigate"):
        return False
    if str(task.owner_user_id) != str(config.get("investigation_owner_user_id")):
        return False
    owner = db.get(User, task.owner_user_id, populate_existing=True)
    agent = db.get(AIAgent, task.agent_id, populate_existing=True)
    if not owner or not owner.is_active or owner.role != "admin" or not agent or not agent.enabled:
        return False
    if agent.slug != config.get("investigation_agent", "coordinator"):
        return False
    provider = db.get(AIProvider, agent.provider_id, populate_existing=True) if agent.provider_id else None
    incident = db.get(Incident, link.incident_id, populate_existing=True)
    if not provider or not provider.enabled or not incident or incident.status == "completed":
        return False
    try:
        enabled_at = datetime.fromisoformat(config.get("investigation_enabled_at") or "")
        return bool(enabled_at.tzinfo and incident.created_at >= enabled_at
                    and incident.source_state == "firing"
                    and incident.last_seen >= datetime.now(timezone.utc) - timedelta(seconds=90)
                    and not (incident.details or {}).get("silenced")
                    and incident.rule not in config.get("excluded_rules", [])
                    and incident.resource not in config.get("excluded_resources", [])
                    and incident.category in config.get("categories", ["disk","cpu","memory","availability","certificate","authentication","traffic","monitoring","other"])
                    and incident.severity in config.get("severities", ["warning","high","critical"]))
    except (TypeError, ValueError):
        return False
