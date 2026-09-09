# Optional integrations

Edit the target's private `.env`, then apply changes with `sudo docker compose up -d` from the installation directory. Keep this file out of Git. Integrations are empty/disabled by default; enabling them may contact or change the equipment you configure.

## AI and Nextcloud Talk

Configure AI providers through the AI settings UI. Provider files live under `DATA_ROOT/secrets/ai-providers`, writable only by the API's UID 1000. SSH credentials and other integration secrets use separate paths.

For an existing Nextcloud Talk bot, place its shared secret at `secrets/integrations/talk-bot-secret` and set `TALK_BACKEND_URL` to your Nextcloud URL. Configure Nextcloud's webhook to the Ops Center integration endpoint. `TALK_MEMORY_BINDINGS` is an optional JSON array of `{actor_id, room_token, user_id}` mappings; use your own actor/room identifiers and Ops Center user UUIDs. Registering the bot and configuring Nextcloud are outside the installer.

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

`WG_EASY_URL` enables the existing legacy wg-easy `/api/wireguard/client` integration. Its client expects a trusted private API without an interactive authentication flow. Newer or differently configured wg-easy deployments may be incompatible. Do not disable authentication on a public endpoint to accommodate it. The installer does not create a VPN or routing/firewall rules.

## Traffic map

Set `TRAFFIC_CADDY_HOST` and/or `TRAFFIC_NPM_HOST` to hostnames already onboarded with SSH credentials. Set `TRAFFIC_CADDY_LOG` and `TRAFFIC_NPM_LOG_DIR` to your log paths. The Caddy reader uses non-interactive sudo for read access. A supported MMDB database at `DATA_ROOT/geoip/dbip-city-lite.mmdb` enables locations; no GeoIP data is bundled.

## Logs from managed hosts

Loki is internal by default. Before installing Alloy on managed hosts, provide an appropriately protected, reachable ingestion endpoint and set `LOKI_EXTERNAL_URL`. The shipped Alloy playbook is basic and does not configure custom authentication credentials. Adapt its configuration to your ingress before enabling remote log shipping.

## HA status

The application retains optional Patroni and Sentinel status integration. Set `PATRONI_NODES`, `POSTGRES_VIP`, `PATRONI_RESTAPI_PASSWORD`, `REDIS_SENTINELS` and related values only for an existing compatible cluster. The standard Compose file still runs a local PostgreSQL and Redis and is not a ready-made HA deployment. Design and validate HA separately.
