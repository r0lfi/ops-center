# Optional integrations

Edit the target's private `.env`, then apply changes with `sudo docker compose up -d` from the installation directory. Keep this file out of Git. Integrations are empty/disabled by default; enabling them may contact or change the equipment you configure.

## AI and Nextcloud Talk

Configure AI providers through the AI settings UI. Provider files live under `DATA_ROOT/secrets/ai-providers`, writable only by the API's UID 1000. SSH credentials and other integration secrets use separate paths.

For an existing Nextcloud Talk bot, place its shared secret at `secrets/integrations/talk-bot-secret` and set `TALK_BACKEND_URL` to your Nextcloud URL. Configure Nextcloud's webhook to the Ops Center integration endpoint. Set `TALK_NOTIFICATIONS_ENABLED=true` to opt into background delivery. The API and AI worker must use the same explicitly configured HTTPS backend; webhook-supplied destinations are not trusted. `TALK_MEMORY_BINDINGS` is an optional JSON array of `{actor_id, room_token, user_id}` mappings; use your own actor/room identifiers and Ops Center user UUIDs. Registering the bot and configuring Nextcloud are outside the installer.

## Cameras and UniFi

Example configuration uses documentation addresses, not real equipment:

```dotenv
CAMERAS='[["camera-01","192.0.2.10",554,"tapo"]]'
STREAMED_CAMERAS='["camera-01"]'
GO2RTC_URL=http://streaming.example.org:1984
```

Only add a streamed camera after configuring its matching stream name in your existing go2rtc instance. No camera passwords or go2rtc configuration are bundled.

The watchdog actively asks UniFi to reconnect unreachable clients. Opt in with `CAMERA_WATCHDOG_TARGETS='[["camera-01","192.0.2.10"]]'` and `UNIFI_URL=https://controller.example.org:8443`. Place a JSON object containing your controller `username` and `password` in `secrets/integrations/unifi-controller.json` with owner 1000 and mode 0600. TLS verification defaults to true. This integration targets the classic controller API and its `default` site; it is not a general UniFi installer.

## VPN

Set `WIREGUARD_URL=https://vpn-admin.example.org` for a wg-easy **v14** session API. Store the password under `DATA_ROOT/secrets/integrations/wireguard-admin-password` (owner UID 1000, mode 0600), or set `WIREGUARD_PASSWORD_PATH` to another path relative to the secrets root. Ops Center establishes a verified HTTPS session for each operation and closes it afterward. No VPN password or session cookie enters the browser. Other versions may have a different API contract; do not disable upstream authentication to accommodate them. This replaces the former unauthenticated `WG_EASY_URL` integration. The installer does not create VPN, routing or firewall rules.

## Traffic Map

Use **Settings → Traffic Map & authentication** to add your own onboarded servers, source types, paths, retention and trusted login origins. New installations start disabled. The supported readers are Nginx Proxy Manager, Caddy, application authentication JSONL, OpenSSH journals and WireGuard handshakes. See [Traffic Map setup and upgrade guide](traffic-map.md).

A supported local MMDB file at `DATA_ROOT/geoip/dbip-city-lite.mmdb` enables locations. No GeoIP database is bundled. Server destination coordinates are entered on the server record. Legacy `TRAFFIC_CADDY_*`/`TRAFFIC_NPM_*` environment settings are replaced by database configuration.

## Logs from managed hosts

Loki is internal by default. Before installing Alloy on managed hosts, provide an appropriately protected, reachable ingestion endpoint and set `LOKI_EXTERNAL_URL`. The shipped Alloy playbook is basic and does not configure custom authentication credentials. Adapt its configuration to your ingress before enabling remote log shipping.

## HA status

The application retains optional Patroni and Sentinel status integration. Set `PATRONI_NODES`, `POSTGRES_VIP`, `PATRONI_RESTAPI_PASSWORD`, `REDIS_SENTINELS` and related values only for an existing compatible cluster. The standard Compose file still runs a local PostgreSQL and Redis and is not a ready-made HA deployment. Design and validate HA separately.
