# Traffic Map and authentication monitoring

Traffic Map is an optional backend collector with persistent PostgreSQL history.
The browser and installed PWA use the same API. No servers, countries, domains,
credentials or dynamic DNS exemptions are preconfigured for a new installation.

## Configure your own environment

1. Add the servers under **Servers**, associate managed SSH credentials, and
   complete onboarding. Verify the recorded SSH fingerprint independently before
   granting access. Set latitude/longitude on each server if it should have a
   destination marker. Destination coordinates are not discovered externally.
2. Open **Settings → Traffic Map & authentication** as an administrator.
3. Add a source, select its server and reader type, and enter the actual log
   path/interface/unit for that server. Give it a stable source ID and a display
   name. IDs are used by history, filters and checkpoints; create a new ID when
   replacing a source with a different server or service.
4. Configure any trusted countries (English GeoIP names) and dynamic DNS
   hostnames. Empty lists grant no exemptions. Enable the sources and collection,
   then save. No rebuild or restart is required for later Settings changes.
5. Check **Traffic Map → Collection status**. Missing credentials, a changed
   host key, an unreadable log or a missing remote Python/command produces a
   visible unavailable state. The collector retries without discarding its cursor.

The API accepts at most 32 sources. Each source must reference an existing Host
record; the form does not accept SSH passwords, keys, raw commands or arbitrary
connection URLs. Settings are administrator-only and audit-logged. Concurrent
edits use a revision number: reload on HTTP 409 before applying your changes.
The supervisor reconciles changes every 10 seconds. An already running read has
an additional 30-second timeout. Disabling monitoring preserves saved history.
Removing a source stops collection; its observations expire under retention.

## Reader formats and prerequisites

All readers require Python 3 on the managed host. Leave **Run reader with
non-interactive sudo** off when the SSH account can read the source directly.
Enabling it requires an existing non-interactive sudo policy. Running arbitrary
Python as root is a privileged capability; use dedicated managed accounts and
restrict who can administer Ops Center. This feature does not install sudo rules.

| Reader | Required configuration | Observations |
| --- | --- | --- |
| Nginx Proxy Manager | Absolute access-log path/glob, e.g. `/var/log/nginx-proxy-manager/proxy-host-*_access.log` | HTTP metadata from the standard NPM proxy-host format |
| Caddy | JSON access-log path/glob, e.g. `/var/log/caddy/access.log` | HTTP metadata; configure Caddy's trusted proxies to establish the actual client IP |
| OpenSSH | systemd unit such as `sshd` or `ssh`; optional display hostname | Accepted authentication from the journal; failed authentication only when explicitly enabled |
| Application authentication JSONL | Absolute file path and service hostname | Explicit application audit outcomes, independent of HTTP redirects/status |
| WireGuard | Interface, service hostname, optional Docker container | Authenticated endpoint handshakes from `wg show`; `docker` is needed only for container mode |

NPM/Caddy parsing discards non-public client IPs. SSH and application audit
readers retain private source addresses for local access investigations. Unknown
GeoIP locations remain unknown. HTTP 200/404 is not evidence of a login.

For NPM, selecting **Jellyfin** or **wg-easy session API** additionally requires
explicit authentication hostnames. Only recognized POST authentication paths
with both upstream and final HTTP 200 count as successful authentication. A
generic 200/302, a Caddy access-log success, a streaming request or a public
homepage visit does not establish an authenticated session. Other application
successes require the audit format below; do not add URL guesses as success rules.
WireGuard handshakes authenticate a peer, not a named user; rekeys are not new
interactive logins. Failed UDP scans cannot be inferred from handshake data.

### Application audit contract

Have the application append one JSON object per completed authentication outcome:

```json
{"id":"0123456789abcdef0123456789abcdef","ts":1780000000.0,"ip":"192.0.2.25","signal":"auth_success"}
```

- `id`: unique 32-character lowercase hexadecimal event ID, stable across rotation.
- `ts`: Unix time in seconds from a synchronized clock.
- `ip`: client address established by the application/proxy trust boundary.
- `signal`: `auth_success`, `auth_failure`, or `auth_throttled`.

Emit success only after the application has established authentication. Do not
log passwords, tokens, session cookies, usernames or request bodies. The reader
exports only allowlisted metadata even if additional fields appear in a log.
For a single audit path it also reads uncompressed `.1`–`.3` rotations. Access-log
globs select at most 128 files; reads are bounded and rotate their starting file
so one busy log does not starve the others. Journal backlog/gaps are shown in the UI.

## Trust and notification rules

- Failed application logins trigger warning alerts, including from trusted origins.
- Successful application logins and authenticated VPN handshakes outside trusted
  countries/current DNS addresses trigger high-priority alerts.
- SSH trusts only the current public addresses of configured DNS names; a trusted
  country never exempts SSH. Successful SSH authentication outside those addresses
  has high priority. Failed SSH authentication is off by default and can be enabled
  per source. Pre-auth connection noise is not collected as a login failure.
- DNS is refreshed at least every 60 seconds while analysis runs. Failed lookups
  are retried sooner and remove stale exemptions. Unresolved names and unavailable
  GeoIP data are visible; unknown origins are not silently trusted.
- The compact authentication banner appears above Traffic Map in normal and
  wallboard views, scrolls out with the page, and can be minimized. It polls
  independently of map filters and pause. It shows recent observations (5 minutes)
  and unreviewed authentication alerts (24 hours).

Configure `TALK_BACKEND_URL`, `TALK_NOTIFICATIONS_ENABLED=true`, the bot secret
file and administrator `TALK_MEMORY_BINDINGS` before enabling Talk delivery.
**Send authentication alerts** controls authentication notifications separately
from aggregate traffic digests. High-priority authentication notices bypass the
one-minute aggregate digest delay; typical delivery follows the 5-second log
poll plus the 2-second analysis/delivery poll (WireGuard polls every 15 seconds).
Network/provider outages can delay delivery; pending notices are retained for
retry and delivery failure is shown. Delivery is not a real-time SLA.

Alerts are evidence for investigation, never automatic blocking. IP location
alone does not identify a person or prove compromise. Rules isolate sources,
including when two servers serve the same domain. Old alerts without a source
identifier are not re-notified after the configuration migration.

## Storage, privacy and HA

`traffic_events` stores time, IP, approximate location, hostname, status, source,
kind and a classified signal. Paths, query strings, request bodies, usernames,
keys and cookies are not stored. Retention defaults to 30 days/500,000 rows and
is editable (1–365 days; 1,000–5,000,000 rows). Cleanup runs every five minutes.
Alerts have a separate 30-day/10,000-row limit. Retention is not a backup policy.

`traffic_collectors` stores file/journal cursors. A source-specific PostgreSQL
advisory lock prevents simultaneous commits across API nodes; events and cursors
commit in one transaction and event IDs deduplicate retries. A connection identity
change starts a fresh cursor and suppresses retrospective login notifications.
A new source monitors newly arriving activity rather than replaying historical
logins. A separate lock protects analysis/outbox processing across HA nodes.

A local MaxMind-compatible MMDB file at `DATA_ROOT/geoip/dbip-city-lite.mmdb`
enables client locations. Respect the database provider's license and update it
outside Git. No IP lookup service receives collected client addresses. The map
uses OpenStreetMap tiles; the browser contacts that public tile service for the
basemap, not for geolocation. Without tiles, observations/history still work.

## Upgrade and testing

Apply Alembic through `0041` before starting the new API. Upgrade all API nodes
and workers together with the matching frontend. Existing history is preserved.
Legacy `TRAFFIC_CADDY_HOST`, `TRAFFIC_NPM_HOST`, log-path environment variables and
`TRAFFIC_LOGIN_*` trust settings are replaced by database settings. There is no
automatic inference of a previous private topology. Record your current sources,
trust policy, log paths and server IDs before upgrading, then enter them in
Settings before relying on monitoring. Fresh installations start disabled.

Unit tests cover reader redaction, log rotation, source isolation, trust rules,
admin restrictions, revision conflicts, input validation and real loopback SSH
host-key rejection before authentication. `backend/tests/verify_traffic_postgres.py`
requires an explicit disposable `TEST_TRAFFIC_DATABASE_URL` and runs rollback-only
schema checks; never point tests at production. Browser fixtures use synthetic
servers and events. See [validation](validation.md) for commands.

Code entry points: `app/schemas/traffic_settings.py` (contract),
`app/api/routes/traffic_settings.py` (admin writes),
`app/services/traffic_watch.py` (supervisor), `traffic_*_reader.py`/`traffic_reader.py`
(remote bounded parsing), `traffic_store.py` (history), `traffic_auth.py` and
`traffic_security.py` (rules/delivery), and `TrafficSettingsPanel.tsx` (configuration).
