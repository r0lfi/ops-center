# Security and release boundaries

The public source has no deployment `.env`, SSH credentials, runtime database, private inventory or inherited Git history. Provider secrets are created on the target after installation. Tests contain explicitly synthetic credentials; these are never deployment defaults.

The installer generates independent random secrets with Python's `secrets` module, uses URL-safe hexadecimal values for database URLs, creates `.env` exclusively with mode 0600 and never rotates existing credentials implicitly. Administrator input travels through stdin to the container under Ansible `no_log`; it is not included in argv or committed files.

Docker access is powerful. The security worker mounts the Docker socket and can control the host's containers; this effectively grants host-level privileges. Only deploy Ops Center where its administrators are trusted with that access. A read-only socket bind would not make the Docker API read-only. Optional cAdvisor also accesses host files and the Docker socket.

Only the web proxy is published by default, bound to loopback. PostgreSQL, Redis, monitoring services and Loki have no host ports. Use an authenticated HTTPS reverse proxy for shared access. Do not expose an unauthenticated Loki push endpoint or legacy wg-easy/go2rtc endpoints publicly.

Existing SSH automation disables host-key verification in parts of the application and Ansible configuration. Establish trusted management-network access before onboarding hosts; this is not a hardened zero-trust deployment. Optional camera streams use a short-lived token in the request URL, so avoid logging those query strings in external proxies.

SELinux bind mounts use shared `:z` labels on dedicated application files. Do not point data directories at sensitive host directories. The installer does not disable SELinux or reconfigure the firewall.

Release checks complement Gitleaks and human review. Run them against both the working tree and Git history before publication. Backups include secrets and must remain private and encrypted at rest. Never attach them to public issues.

## Browser sessions, Remember me and re-authentication

Signing in creates a server-side session (`user_sessions`, migration 0063):
* **Access token**: a 15-minute JWT that names its session (`sid`). It is held only in browser memory and never in localStorage or sessionStorage.
* **Refresh token**: 32 random bytes in the `ops_refresh` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api/auth`, `Secure` unless `SESSION_COOKIE_SECURE=false`). The database stores only its SHA-256.
* **Renewal**: every page load and every access token near expiry calls `POST /api/auth/refresh`, which rotates the cookie. A previous cookie is accepted for 30 s, so parallel tabs do not fight. Reusing it after that revokes the whole session as a theft signal.
* **Lifetime**: *Remember me* keeps an idle session resumable for 30 days. Use slides that limit, but a remembered session never outlives 90 days from sign-in. Without Remember me the cookie ends with the browser, after 12 idle hours, or 72 hours after sign-in. All limits are configurable (`SESSION_*` in `.env.example`).
* **Immediate end**: the API checks the session on every request. Logout, admin revocation (**Settings → Users → Active sessions**), deactivating a user and resetting a password all end the session at once. Streams (agent SSE, camera MJPEG, container console) check the session when they open.
* **CSRF**: API calls carry the bearer token from memory, which a cross-site page cannot read. The cookie endpoints (`/auth/refresh`, `/auth/logout`) also need `X-Requested-With: ops-center` and a same-origin `Origin`.
* **Re-authentication**: production approval of developer changes, recording a release and revoking another user's session need the password confirmed in the same session within `REAUTH_MAX_AGE_SECONDS` (5 minutes). A session-less token never passes this check. Local administration scripts mint session-less tokens marked `local` with the API secret.
* **Upgrade**: tokens from before 0063 carry no session and are refused. Every browser signs in once.

## AI provider API keys

AI provider keys are pasted on the **AI Agents** page and stored in the
database encrypted with Fernet. The encryption key is derived from
`API_SECRET_KEY` with its own context, so every HA node can read a key saved
through any node. Keys never appear in API responses, and the audit log
redacts the `api_key` field. Rotating `API_SECRET_KEY` makes stored keys
unreadable; save them again afterwards. Older key files under
`secrets/ai-providers/` are read only as a fallback.

## AI Traffic Monitor collector

The optional `ai-traffic-collector` service (Compose profile `ai-traffic`)
runs with the host network and PID namespaces and the `NET_ADMIN`, `NET_RAW`,
`SYS_PTRACE` and `DAC_READ_SEARCH` capabilities. It only reads: conntrack
events, packet headers of containers labelled `ops-center.ai-traffic=1`, and
`/proc`. It adds no firewall rule or route and never decrypts traffic. Each
node posts with its own token, `HMAC-SHA256(AI_TRAFFIC_INGEST_TOKEN,
OPS_LOCAL_HOSTNAME)`, so one node cannot report for another. Leave the profile
off where that access is not acceptable.

## AI read-only diagnostics (run_diagnostic)

`run_shell_command` stays approval-gated for every command: a pattern list
that guesses which shell is harmless was rejected (see
`worker_ai/ai/tools/shell_tools.py`). Without a read-only alternative, most approval requests
would be plain reads (`df -h`, `docker ps`, `docker logs`).

`run_diagnostic` (`worker_ai/ai/tools/diagnostic_tools.py`) closes that gap
the other way round. The model picks one check from a fixed catalog (disk,
inodes, LVM, mounts, memory, uptime, OS info, processes, failed units,
`systemctl status`, `journalctl`, listening ports, `docker
ps/logs/inspect/stats/system df`, an HTTP GET status check and a DNS lookup).
Each check is a fixed argv template. The few caller values (unit, container,
path, URL, DNS name, line/minute counts) fill fixed slots only after a strict
regex or range check: no braces, no leading `-`, no whitespace in names, no
`..` in paths. `ansible/playbooks/diagnostic-query.yml` runs the argv lists
with `ansible.builtin.command` (never `shell`), wrapped in `timeout 25`,
with `changed_when: false`. The HTTP check discards the body. `docker
inspect` output has every `Config.Env` value replaced by `<redacted>`,
matching `get_container_env_keys`.

It runs without approval, and it is still subject to the agent's
`allowed_tools`, `allowed_hosts` and environment scope like every other host
tool. Output is untrusted evidence and grants no authority. Anything outside
the catalog, and every change, still goes through `run_shell_command`,
`container_action`, `restart_service` and friends, which all need a human
approval. Migration 0048 grants the tool to general, linux, container,
network and monitoring. Downgrading removes the grants and the prompt note.

Report suspected vulnerabilities privately to the repository maintainer. Do not include live credentials or exploit details in a public issue.
