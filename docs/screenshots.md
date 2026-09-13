# Feature screenshots

The README images show the public application's standard interface with synthetic
documentation fixtures. They are not screenshots of an operator's environment or
of a fresh installation. New installations have no managed hosts, and traffic
collection and agent collaboration start disabled.

## Coverage

| Feature | Image | Example shown |
| --- | --- | --- |
| Overview | [overview.png](images/features/overview.png) | Fleet health and resource metrics |
| Server inventory | [servers.png](images/features/servers.png) | Three fictional managed hosts |
| Docker workloads | [containers.png](images/features/containers.png) | Container status and host resource usage |
| Automation | [automation.png](images/features/automation.png) | Bundled health-check playbook and action catalogue |
| Patching | [patching.png](images/features/patching.png) | Disabled schedule and one fictional security update |
| Monitoring | [monitoring.png](images/features/monitoring.png) | Service probes and resource charts |
| Logs | [logs.png](images/features/logs.png) | Generated health and metrics messages |
| Vulnerabilities | [security.png](images/features/security.png) | Fictional advisory and affected package |
| HA cluster | [cluster.png](images/features/cluster.png) | PostgreSQL roles and Redis/Sentinel health |
| AI agents | [agents.png](images/features/agents.png) | Specialist responsibilities and permissions |
| Traffic Map | [traffic-map.png](images/features/traffic-map.png) | World map, authentication banner, country counts and timeline |
| Authentication | [login-events.png](images/features/login-events.png) | Example logins, VPN handshake and reviewable alert |
| Traffic settings | [traffic-settings.png](images/features/traffic-settings.png) | Reader, host, path, trust and retention controls |
| Collaboration | [collaboration.png](images/features/collaboration.png) | Written example transcript and token accounting |
| Collaboration settings | [collaboration-settings.png](images/features/collaboration-settings.png) | Budgets and explicit partner permissions |
| Disk expansion | [disk-expansion.png](images/features/disk-expansion.png) | Pending approval for a fictional storage request |
| VPN integration | [vpn.png](images/features/vpn.png) | Fictional peer status and transfer counters |
| PWA installation | [pwa-install.png](images/features/pwa-install.png) | In-app iPhone/iPad installation help |
| Offline protection | [pwa-offline.png](images/features/pwa-offline.png) | Overlay hiding stale infrastructure data |

The existing [Operations Floor illustration](images/ops-floor.gif) remains in the
README separately from these screenshots.

## Data and capture boundaries

- Hosts, accounts, provider settings, requests, logs and AI messages are invented.
  Domain names use `example.com`; displayed IP addresses use the RFC 5737
  documentation ranges. Dates are fixed at 15 January 2026 in UTC.
- The real production frontend renders the images. Its layout and theme are not
  replaced with mockups. A capture-only label identifies synthetic example data
  in every image; the label is not added to the application.
- The capture script runs its own read-only HTTP fixture on loopback. It reads
  the frontend build and the public `health-check.yml` playbook. It does not load
  environment files, connect to a backend, authenticate to a deployment, contact
  AI providers or execute infrastructure operations. Unmapped API requests fail
  the capture, and non-GET requests are rejected.
- Browser traffic is limited to the fixture origin and the standard world-map
  tiles used by the application. The map includes © OpenStreetMap attribution.
  Only generic zoom-2 tile coordinates are requested; no example observations
  are sent to a geolocation service. See [third-party notices](../THIRD_PARTY_NOTICES.md).
- The PWA guide uses an emulated iPad browser identity. The offline overlay is
  triggered through the application's unavailable-backend event. These images
  demonstrate UI states, not installation on physical hardware or an end-to-end
  service-worker test; see [PWA validation](pwa.md).

## Reproduce

From the public repository, with Node.js and Playwright's browser prerequisites:

```bash
cd frontend
npm ci
npm run build
npx playwright install chromium
node scripts/capture-readme.mjs
```

The script writes the 19 PNG files to `docs/images/features`. To refresh only
selected views, pass their filename stems:

```bash
node scripts/capture-readme.mjs traffic-map traffic-settings
```

Close the process if capture fails before completing. Do not substitute a real
backend or import real environment data into the fixture. Browser/font versions
and map tiles can change pixels between runs; byte-for-byte reproduction is not
guaranteed.

Review every regenerated image visually for content and readability, then update
only its exact SHA-256 entry in `scripts/check-release.py`. The release policy
accepts these specific reviewed bytes and rejects an altered image or an image at
an unreviewed path. Keep the README references and this coverage table in sync,
and run the release policy and Gitleaks before publishing.

## MCP screenshots

The MCP client, agent access, consent and change-approval images use only synthetic data.
They are captured from the actual UI by `frontend/scripts/capture-mcp.mjs` after building the frontend.
Run `node scripts/capture-mcp.mjs` from `frontend/`; set `MCP_SCREENSHOT_OUTPUT` to choose the output directory.
The script serves a local production build, intercepts every API request with synthetic fixtures, and crops the relevant UI.
It hides the unrelated floating chat shortcut in cropped cards. No live environment, real user, token, host or log is used.

- `docs/images/mcp-clients.png`: client registration, exact callback, users and tool permissions.
- `docs/images/mcp-agents.png`: the existing agent and task owner, duration and permitted MCP tools.
- `docs/images/mcp-consent.png`: user consent with a selected tool subset.
- `docs/images/mcp-approvals.png`: a pending synthetic container restart and exact-argument review.
