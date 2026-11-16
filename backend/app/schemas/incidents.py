import uuid
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

CATEGORIES = (
    "disk",
    "cpu",
    "memory",
    "availability",
    "certificate",
    "authentication",
    "traffic",
    "monitoring",
    "other",
)
SEVERITIES = ("info", "warning", "high", "critical")


class IMConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(default=0, ge=0)
    # False = notifications only: alerts still go to Talk, but IM tasks close
    # themselves after confirmed recovery and no AI investigation starts.
    # All other IM settings are kept for when the workflow is re-enabled.
    workflow_enabled: bool = True
    talk_enabled: bool = True
    categories: list[
        Literal[
            "disk",
            "cpu",
            "memory",
            "availability",
            "certificate",
            "authentication",
            "traffic",
            "monitoring",
            "other",
        ]
    ] = Field(default_factory=lambda: list(CATEGORIES), max_length=9)
    severities: list[Literal["info", "warning", "high", "critical"]] = Field(
        default_factory=lambda: ["warning", "high", "critical"], max_length=4
    )
    excluded_rules: list[str] = Field(default_factory=list, max_length=100)
    excluded_resources: list[str] = Field(default_factory=list, max_length=100)
    recovery_minutes: int = Field(default=30, ge=30, le=1440)
    talk_progress: bool = False
    auto_investigate: bool = False
    investigation_agent: str = Field(default="coordinator", pattern=r"^[a-z0-9_-]{1,50}$")
    investigation_owner_user_id: uuid.UUID | None = None
    investigation_enabled_at: datetime | None = None
    max_active_investigations: int = Field(default=2, ge=1, le=4)


class IMDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    status: Literal["approved", "in_progress", "completed"]
    note: str = Field(default="", max_length=2000)
