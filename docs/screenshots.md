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
| Ops Floor (2D plan) | [ops-floor.png](images/features/ops-floor.png) | Agent rooms, live status, a pending approval and the external crew |
| Ops Floor (3D office) | [ops-floor-3d.png](images/features/ops-floor-3d.png) | The same agents at their desks in the isometric office |
| AI overview | [ai-overview.png](images/features/ai-overview.png) | Agents at work, pending approval and live activity |
| AI Traffic Monitor | [ai-traffic.png](images/features/ai-traffic.png) | Live map of example model, API and internal connections |
| Incidents | [incidents.png](images/features/incidents.png) | Four fictional incidents in different states |
| Developer Agent | [developer-agent.png](images/features/developer-agent.png) | Tool proposals in progress, ready for review and approved |
| Personal agent | [personal-agent.png](images/features/personal-agent.png) | The example personal agent "Nova" and its requests |
| Command palette | [command-palette.png](images/features/command-palette.png) | Ctrl+K search across pages |
| Phone layout | [mobile.png](images/features/mobile.png) | Ops Floor on a phone-sized screen |
| opstui dashboard | [opstui-dashboard.png](images/features/opstui-dashboard.png) | Terminal dashboard with example agents and an approval |
| opstui Ops Floor | [opstui-floor.png](images/features/opstui-floor.png) | The 2D plan in a terminal |
| PWA installation | [pwa-install.png](images/features/pwa-install.png) | In-app iPhone/iPad installation help |
| Offline protection | [pwa-offline.png](images/features/pwa-offline.png) | Overlay hiding stale infrastructure data |

The animated [Ops Floor](images/ops-floor.gif) at the top of the README is the
2D plan from the same fixture. The fixture plays a fixed script of agent events
(delegation, tool use, an approval request, completion) over the agent event
stream; the browser renders them as the application would live. Other captures
receive a silent stream.

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
  the capture, and non-GET requests are rejected, except session renewal
  (`POST /api/auth/refresh`), which returns a placeholder token kept in memory.
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

The script writes the 28 PNG files to `docs/images/features` and the animation
frames to `frontend/test-results/ops-floor-live-frames`. Build the GIF from those
frames with Pillow:

```bash
node scripts/capture-readme.mjs ops-floor-live
python3 scripts/frames-to-gif.py test-results/ops-floor-live-frames ../docs/images/ops-floor.gif
```

 To refresh only
selected views, pass their filename stems:

```bash
node scripts/capture-readme.mjs traffic-map traffic-settings
```

The opstui images are rendered by an ignored Rust test (synthetic data, no
server) and turned into PNGs by Playwright:

```bash
cd tui && OPSTUI_SCREENSHOT_DIR=/tmp/opstui cargo test --test screenshot -- --ignored
cd ../frontend && node scripts/capture-tui.mjs /tmp/opstui
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
