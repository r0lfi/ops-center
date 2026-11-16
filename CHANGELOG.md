# Changelog

Notable changes to Ops Center. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may
contain breaking changes; they are always listed here.

A release needs its own `## [X.Y.Z] - YYYY-MM-DD` section: the release workflow
uses it as the release notes and refuses a tag without one. See
[docs/releasing.md](docs/releasing.md).

## [Unreleased]

## [0.2.0] - 2026-11-16

The largest update since 0.1.0. Existing installations: read
[Upgrading to the November 2026 update](README.md#upgrading-to-the-november-2026-update)
first. **Migrations `0043`–`0066` run on start, and every browser signs in once.**

### Added

- **Ops Floor** rebuilt: one status model for all agents, fixed seats, a 2D plan
  and a 3D office built from CSS (the Three.js scene and its packages are gone),
  approvals and chat on the floor, what each agent is doing right now, and a date
  on the activity log.
- **AI overview** shows who is working and answers approvals in place; **Ask Ops
  AI** is a floating, page-aware assistant with large and pinned modes.
- **Agent investigations** on a shared task board: work items, findings,
  hypotheses, parallel delegation, time/context/tool budgets, resumable runs.
- **Read-only diagnostics** (`run_diagnostic`, `file_grep`) from a fixed,
  validated catalog that runs without approval.
- **Developer Agent**: tool proposals become reviewable patches with checks,
  change review, re-authentication for production approval and a release record.
  `scripts/admin/apply-tool-proposal.sh` applies an approved patch on a branch.
- **Incident management**: one incident per problem, status workflow,
  single-notice Talk delivery with retries, optional automatic AI investigations.
- **AI Traffic Monitor**: worker instrumentation plus an optional passive
  collector (`ai-traffic-collector` image, Compose profile `ai-traffic`), with
  live traffic, live map, blocked/failed, agent traces, network flow and coverage.
- **Weekly AI budget** in USD shared by all agents, priced per reviewed model,
  with reservation before and settlement after each call; editable in Settings.
- **Providers**: Mistral AI, OpenAI-compatible local models and Ollama context
  size; provider keys encrypted in the database; retries on provider overload.
- **Personal agent** (example name *Nova*): memory suggestions, organised notes
  with history, imports from ChatGPT and other assistants, a nightly journal,
  routines and optional read-only CalDAV/Home Assistant sources.
- **External agents** (`runtime: "external"`, for example opencode) report their
  state and appear on the Ops Floor.
- **Native monitoring** of hosts and containers from Prometheus with detail pages.
- **Interface**: new menu, Ctrl+K command palette, filters in the URL, settings
  in tabs, one date/number/severity format, every page usable on phones.
- **Sessions**: server-side sessions, in-memory access tokens, rotating HttpOnly
  refresh cookie, *Remember me*, revocation and re-authentication.
- **opstui**: a Rust/Ratatui terminal interface for agents, tasks, approvals,
  chat and the Ops Floor, including local Claude Code sessions.
- Patching agent checks pending updates and reboot need live on the host.
- MCP: the AI menu shows MCP access per agent and owner; agents use MCP only on
  the local network; `ops_ask_ops_ai` accepts page context (114 tools).
- Import of Claude Code memory files as shared notes
  (`scripts/admin/import-claude-memory.py`).

### Changed

- Access tokens expire after 15 minutes (was 60) and are renewed from the cookie.
- Overview, monitoring and security pages count the same way.
- The scheduler's lock interval is shorter, so a failover no longer blocks
  scheduled tasks for up to 25 minutes.
- Patch history and the exec audit trail are kept; the health endpoint is bounded.
- Worker and API images install with pinned dependency constraints.
- README screenshots are regenerated from the current interface, with new images
  for the Ops Floor, AI overview, AI Traffic Monitor, incidents, Developer Agent,
  personal agent, command palette and phone layout. The animated README image
  of the old 3D scene is replaced by an animated 2D plan rendered from the
  synthetic fixture (`frontend/scripts/frames-to-gif.py`).

### Upgrade notes

- Everyone signs in again after migration `0063`. Over plain HTTP on anything
  other than localhost, set `SESSION_COOKIE_SECURE=false`.
- Save AI provider keys once on the AI Agents page to store them encrypted.
- Set the weekly AI budget; unpriced models are refused.

## [0.1.0] - 2026-10-02

First versioned release. Earlier changes were published without version
numbers; see the Git history and
[docs/releases](https://github.com/r0lfi/ops-center/tree/main/docs/releases).

### Added

- Versioned releases. A `vX.Y.Z` tag builds every application image, runs the
  whole stack from those images, publishes them to
  `ghcr.io/r0lfi/ops-center/<component>` and creates the GitHub Release.
- Image tags `X.Y.Z`, `vX.Y.Z`, `X.Y`, `X` and `latest`; prereleases are
  published only as their exact version.
- Images carry OCI labels with version, revision, source and license; the API
  reports the release version in `/api/health`; the API image has a health check.
- `scripts/test/smoke-stack.sh`: starts a disposable stack from built or
  published images and checks health, the web interface, login and persistence.
- Pull requests and branches build every application image without pushing.

### Changed

- Re-running the installer with `ops_build_images=false` now updates
  `IMAGE_PREFIX` and `IMAGE_TAG` in an existing `.env`, so upgrading to a
  published release is the same command as installing it.
- The manual "Build or publish images" workflow is replaced by the release
  workflow; `scripts/images.sh` still builds and pushes images by hand.

[Unreleased]: https://github.com/r0lfi/ops-center/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/r0lfi/ops-center/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/r0lfi/ops-center/releases/tag/v0.1.0
