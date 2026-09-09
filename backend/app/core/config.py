from functools import lru_cache
from uuid import UUID
from pydantic import BaseModel, Field


class TalkMemoryBinding(BaseModel):
    actor_id: str
    room_token: str
    user_id: UUID


from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ops_center_env: str = "production"
    api_secret_key: str
    api_log_level: str = "info"
    access_token_expire_minutes: int = 60

    database_url: str
    database_url_sync: str
    redis_url: str

    app_name: str = "Ops Center"
    app_version: str = "0.1.0"

    secrets_root: str = "/app/secrets"
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
    loki_url: str = "http://loki:3100/ready"
    tz: str = "UTC"
    cameras: list[tuple[str, str, int, str]] = Field(default_factory=list)
    streamed_cameras: list[str] = Field(default_factory=list)
    camera_watchdog_targets: list[tuple[str, str]] = Field(default_factory=list)
    go2rtc_url: str = ""
    wg_easy_url: str = ""
    unifi_url: str = ""
    unifi_verify_tls: bool = True
    traffic_caddy_host: str = ""
    traffic_npm_host: str = ""
    traffic_caddy_log: str = "/var/log/caddy/access.log"
    traffic_npm_log_dir: str = "/var/log/nginx-proxy-manager"

    # Nextcloud Talk bot (app/api/routes/integrations.py): the shared
    # secret registered with `occ talk:bot:install`, as a file under
    # secrets_root like every other secret here - never in .env. The
    # worker reads the same path (worker_ai/talk.py).
    talk_bot_secret_path: str = "integrations/talk-bot-secret"
    talk_memory_bindings: list[TalkMemoryBinding] = Field(default_factory=list)


@lru_cache
def get_settings() -> Settings:
    return Settings()
