"""Validated monitoring configuration. Only administrators can change this data.

Source IDs are stable labels used in history and checkpoints. Connections always
refer to managed Host records; this API never accepts credentials or commands.
"""

import re
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def hostname(value: str) -> str:
    value = value.strip().lower().rstrip(".")
    if len(value) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value):
        raise ValueError("Enter a hostname/domain without a URL, port or credentials")
    if any(
        not part or len(part) > 63 or part.startswith("-") or part.endswith("-")
        for part in value.split(".")
    ):
        raise ValueError("Invalid hostname")
    return value


class TrafficSourceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$")
    label: str = Field(min_length=1, max_length=80)
    host_id: UUID
    kind: Literal["npm", "caddy", "ssh", "auth_audit", "wireguard"]
    enabled: bool = True
    use_sudo: bool = True
    log_path: str = Field(default="", max_length=400)
    domain: str = ""
    application: Literal["generic", "jellyfin", "wg_easy"] = "generic"
    auth_domains: list[str] = Field(default_factory=list, max_length=30)
    container: str = Field(
        default="", max_length=128, pattern=r"^(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$"
    )
    interface: str = Field(default="wg0", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$")
    journal_unit: str = Field(
        default="sshd", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,79}$"
    )
    ssh_failures: bool = False

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, value):
        return hostname(value) if value else ""

    @field_validator("auth_domains")
    @classmethod
    def validate_domains(cls, values):
        return list(dict.fromkeys(hostname(v) for v in values))

    @field_validator("log_path")
    @classmethod
    def validate_path(cls, value):
        if value and (
            not re.fullmatch(r"/[a-zA-Z0-9_./*?-]+", value)
            or any(p in (".", "..") for p in value.split("/"))
        ):
            raise ValueError(
                "Use an absolute log path/glob without traversal, whitespace or shell expressions"
            )
        return value

    @model_validator(mode="after")
    def check_kind(self):
        if self.id in ("all", "security"):
            raise ValueError("Source IDs all and security are reserved")
        if self.kind in ("npm", "caddy", "auth_audit") and not self.log_path:
            raise ValueError("This source needs an absolute log path")
        if self.kind in ("auth_audit", "wireguard") and not self.domain:
            raise ValueError("This source needs a service domain")
        if self.application != "generic" and (
            self.kind != "npm" or not self.auth_domains
        ):
            raise ValueError(
                "Verified application login classification requires NPM and explicit application domains"
            )
        return self


class TrafficSettingsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(default=0, ge=0)
    enabled: bool = False
    sources: list[TrafficSourceConfig] = Field(default_factory=list, max_length=32)
    allowed_countries: list[str] = Field(default_factory=list, max_length=50)
    trusted_dns: list[str] = Field(default_factory=list, max_length=8)
    retention_days: int = Field(default=30, ge=1, le=365)
    max_rows: int = Field(default=500000, ge=1000, le=5000000)
    notify_authentication: bool = True

    @field_validator("trusted_dns")
    @classmethod
    def validate_dns(cls, values):
        return list(dict.fromkeys(hostname(v) for v in values))

    @field_validator("allowed_countries")
    @classmethod
    def validate_countries(cls, values):
        if any(
            not re.fullmatch(r"[A-Za-z][A-Za-z .'-]{0,79}", v.strip()) for v in values
        ):
            raise ValueError("Use GeoIP English country names")
        return list(dict.fromkeys(v.strip() for v in values))

    @model_validator(mode="after")
    def distinct_sources(self):
        if len({s.id for s in self.sources}) != len(self.sources):
            raise ValueError("Source IDs must be unique")
        return self
