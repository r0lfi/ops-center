from functools import lru_cache
from uuid import UUID
from typing import Annotated, Literal
import json
from pydantic import BaseModel, Field, field_validator, model_validator


class TalkMemoryBinding(BaseModel):
    actor_id: str
    room_token: str
    user_id: UUID


class TalkAgentRoute(BaseModel):
    """Send one private Talk room to an agent other than the coordinator.
    Only honoured for senders with a TalkMemoryBinding for the same room."""
    room_token: str = Field(pattern=r"^[a-zA-Z0-9]{4,64}$")
    agent_slug: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,49}$")


class NovaDataSource(BaseModel):
    """A read-only personal data source for one owner's personal agent (nova phase 5).

    Only that owner's personal-agent tasks can read it (app/services/nova_sources.py).
    The credential is a file under secrets_root (secret_path), never in .env.
    """
    kind: Literal["caldav", "homeassistant"]
    owner_user_id: UUID
    url: str = Field(pattern=r"^https?://[^\s/@]+(/[^\s@]*)?$", max_length=300)
    secret_path: str = Field(pattern=r"^[A-Za-z0-9_-][A-Za-z0-9._/-]*$", max_length=200)
    # CalDAV: the account and the calendar / task list names (URL segments) to read.
    username: str = Field(default="", pattern=r"^[A-Za-z0-9._@-]*$", max_length=100)
    calendars: list[Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")]] = Field(default_factory=list, max_length=20)
    task_lists: list[Annotated[str, Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")]] = Field(default_factory=list, max_length=20)
    # Home Assistant: the only entities nova may read.
    entities: list[Annotated[str, Field(pattern=r"^[a-z_]+\.[a-z0-9_]+$")]] = Field(default_factory=list, max_length=100)
    # Off by default: no calendar or home data is offered while nova uses a cloud provider.
    allow_cloud: bool = False

    @model_validator(mode="after")
    def complete(self):
        if ".." in self.secret_path.split("/"):
            raise ValueError("secret_path must stay under the secrets root")
        if self.kind == "caldav":
            if not self.url.startswith("https://") or not self.username or not (self.calendars or self.task_lists):
                raise ValueError("caldav needs an https url, a username and at least one calendar or task list")
            if self.entities:
                raise ValueError("entities apply to homeassistant only")
        elif not self.entities or self.username or self.calendars or self.task_lists:
            raise ValueError("homeassistant needs entities and no caldav fields")
        return self


from pydantic_settings import BaseSettings, SettingsConfigDict, NoDecode


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ops_center_env: str = "production"
    api_secret_key: str
    api_log_level: str = "info"
    # Access tokens live only in browser memory; the refresh cookie renews them.
    access_token_expire_minutes: int = 15
    # "Remember me": an idle session can be resumed within this many days.
    session_remember_idle_days: int = 30
    # Hard cap for a remembered session, however active it stays.
    session_remember_absolute_days: int = 90
    # Without "Remember me": a browser-session cookie with these limits.
    session_idle_hours: int = 12
    session_absolute_hours: int = 72
    # Set false only when Ops Center is served over plain HTTP on a trusted LAN.
    session_cookie_secure: bool = True
    # Approvals and session administration need a password check this recent.
    reauth_max_age_seconds: int = 300

    database_url: str
    database_url_sync: str
    redis_url: str

    mcp_public_url: str = ""
    # Shared secret of the passive AI traffic collector (ai_traffic_collector/); empty disables ingest.
    ai_traffic_ingest_token: str = ""
    mcp_allowed_origins: list[str] = Field(default_factory=list)

    app_name: str = "Ops Center"
    app_version: str = "0.1.0"

    secrets_root: str = "/app/secrets"
    wireguard_url: str = ""
    wireguard_password_path: str = "integrations/wireguard-admin-password"
    talk_backend_url: str = ""
    talk_notifications_enabled: bool = False
    geoip_db_path: str = "/app/geoip/dbip-city-lite.mmdb"

    # Optional integrations are inactive until configured.
    patroni_nodes: str = ""
    patroni_rest_port: int = 8008
    patroni_scope: str = "ops-center-postgres"
    patroni_restapi_username: str = "patroni_admin"
    patroni_restapi_password: str = ""
    postgres_vip: str = ""
    redis_password: str = ""
    redis_sentinels: str = ""
    redis_master_name: str = "ops-center-redis"
    redis_nodes: str = "redis"
    ops_local_hostname: str = "ops-host"
    prometheus_query_url: str = "http://prometheus:9090"
    # Explicit Prometheus cAdvisor instance -> inventory host UUID mapping.
    # A host_id target label takes precedence. Never infer host from container name.
    monitoring_container_targets: Annotated[dict[str, str], NoDecode] = Field(default_factory=dict)
    @field_validator("monitoring_container_targets", mode="before")
    @classmethod
    def parse_container_targets(cls, value):
        value = json.loads(value) if isinstance(value, str) and value else value or {}
        if not isinstance(value, dict) or len(value) > 100:
            raise ValueError("Expected at most 100 cAdvisor target mappings")
        for host_id in value.values():
            UUID(host_id)
        return value

    loki_url: str = "http://loki:3100/ready"
    # worker/scheduled_tasks.py: rows older than this are deleted hourly from
    # docker_events and ansible_events.
    event_retention_days: int = Field(default=30, ge=1)
    # A job still queued or running after this long has lost its worker.
    # Must stay above the longest real job (a full patch run takes hours).
    orphaned_job_after_hours: int = Field(default=24, ge=1)
    tz: str = "UTC"
    cameras: list[tuple[str, str, int, str]] = Field(default_factory=list)
    streamed_cameras: list[str] = Field(default_factory=list)
    camera_watchdog_targets: list[tuple[str, str]] = Field(default_factory=list)
    go2rtc_url: str = ""
    unifi_url: str = ""
    unifi_verify_tls: bool = True

    # Nextcloud Talk bot (app/api/routes/integrations.py): the shared
    # secret registered with `occ talk:bot:install`, as a file under
    # secrets_root like every other secret here - never in .env. The
    # worker reads the same path (worker_ai/talk.py).
    talk_bot_secret_path: str = "integrations/talk-bot-secret"
    talk_memory_bindings: list[TalkMemoryBinding] = Field(default_factory=list)
    talk_agent_routes: list[TalkAgentRoute] = Field(default_factory=list)
    # Read-only calendar and Home Assistant sources for personal agents (docs/nova.md).
    nova_data_sources: list[NovaDataSource] = Field(default_factory=list, max_length=20)

    @field_validator("nova_data_sources")
    @classmethod
    def one_source_per_kind_and_owner(cls, value):
        if len({(s.kind, s.owner_user_id) for s in value}) != len(value):
            raise ValueError("At most one nova data source per kind and owner")
        return value
    # Nova imports (app/services/nova_import.py): upload size, the largest
    # JSON file read from a ChatGPT export, and the zip compression ratio
    # beyond which a member is treated as a zip bomb. Parsed JSON takes several
    # times its size in memory; only one export is parsed at a time per API.
    nova_import_max_mb: int = 200
    nova_import_max_json_mb: int = 64
    nova_import_max_ratio: int = 200
    # Context window requested from Ollama providers (0 = the server's own
    # default, which is often too small for agent prompts).
    ollama_num_ctx: int = 32768



@lru_cache
def get_settings() -> Settings:
    return Settings()
