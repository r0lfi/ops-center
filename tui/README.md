# opstui – Ops-Center terminal interface

`opstui` is a Rust/Ratatui operator console for Ops-Center's AI agents. It
uses the same backend, sessions and role checks as the web GUI. Agents, tasks,
approvals, chat and history stay the same records in both interfaces. There is
no separate agent, chat or memory system.


## Install and update

The host needs Podman, but not a Rust toolchain. The build runs in
`Containerfile.build` (AlmaLinux 10.2 with AppStream Rust), the same pattern as
`ai_traffic_collector`.

```bash
cd ops-center/tui
./install.sh          # fmt check, clippy -D warnings, tests, release build, install
./install.sh check    # checks and tests only
./install.sh fmt      # apply rustfmt
```

The binary goes to `~/.local/bin/opstui`, which is already on `PATH`. Set
`OPSTUI_BIN_DIR` to install elsewhere. To update, pull the branch and run
`./install.sh` again. Cargo downloads are cached in `~/.cache/opstui-cargo`.

## Run

```bash
opstui                                  # sign in, then the dashboard
opstui --server https://ops.example.org # override the configured server
opstui --user alice                     # prefill the username
opstui --config                         # show (and on first use create) the config file
opstui --help | --version
```

`opstui` asks for the password at every start. The access token stays in
memory, and the refresh cookie lives only in the process's cookie jar.
Nothing secret is written to disk.

`~/.config/opstui/config.toml`:

```toml
server = "https://ops.example.org"
username = "alice"
environment = "prod"     # label in the top bar; empty shows the server host
refresh_seconds = 5      # REST snapshot interval (2–300)
metrics_host = ""        # one Prometheus host for CPU/RAM; empty averages all
mouse = true             # tab clicks and scrolling; false keeps terminal selection
```

The log is written to `~/.local/state/opstui/opstui.log`. Set the level with
`OPSTUI_LOG` (for example `OPSTUI_LOG=opstui=debug`). Tokens, passwords and
request bodies are never logged.

## Views and keys

| Key | Action |
| --- | --- |
| `1`–`9` | Dashboard, Agents, Tasks, Approvals, Logs, Chat, History, Settings, Ops Floor |
| `↑ ↓` / `j k`, `PgUp PgDn`, `Home End` | Move |
| `Enter` | Open or select (details, run log, event) |
| `→` / `←` | Agents and Chat: open / close a category (`Enter` on a category toggles it) |
| `Esc` | Back, or clear the current filter |
| `Tab` / `Shift+Tab` | Next or previous panel |
| `/` | Search in the current view |
| `a` / `r` | Approve / reject (Approvals view; on the dashboard whatever panel has focus). A dialog confirms the result and says how many approvals are still waiting |
| `c` | Dashboard: type into the chat panel (default agent: coordinator); click the panel too |
| `Tab` while typing | Choose which agent to talk to (or click "to … ▾") |
| `d` `t` `s` `o` | Diff (full screen), tests, security checks, details |
| `c` (Approvals view) | Request changes to a finished patch (with a comment) |
| `p` | Record a production release of an approved change (separate step) |
| `n` | New task: choose an agent and describe it |
| `m` | Message the selected agent (opens Chat) |
| `x` | Stop the selected agent's or task's open task (with confirmation) |
| `R` | Resume a task the backend reports as resumable |
| `l` | Logs filtered to the selected agent or task |
| `f` | Filter by agent status or task group |
| `Space` / `F` | Logs: pause / follow (autoscroll) |
| `g` / `e` / `t` / `c` | Logs: cycle agent, minimum severity, AI traffic monitor, clear filters |
| `i` / `N` | Chat: type / start a new conversation |
| `?` | Help |
| `q`, `Ctrl+C` | Quit |

While you type in chat, search, a dialog or the sign-in form, keys go to the
text field and do not trigger shortcuts. With mouse capture enabled, you can
click a tab to switch view and scroll the wheel in a panel. Hold Shift to
select text in most terminals.

Layout: from 120×30 up you get the full dashboard as in the reference image.
Smaller terminals (SSH, tmux splits) get a compact dashboard and stacked
panels. Colours are 24-bit. Use a terminal or tmux with truecolor
(`set -ga terminal-overrides ",*256col*:Tc"`) for exact colours.

The bottom status line shows AI token use (input/output tokens, calls and
cost today and over 7 days, from `/ai/usage`) and the shared weekly budget
(`/ai/budget`). Unpriced calls show "cost unknown" instead of a guess.

## Agent categories

The agent list (Agents view and the dashboard panel) is grouped by the
agent's metadata, not its name: `personal` agents under **Personal Agents**,
`runtime = "native"` (or none reported) under **OPS Agents**, and every other
runtime (`external`, local Claude, anything new) under **External Agents**.
Empty categories are hidden. Each header shows the number of agents and how
many are working. `→`/`←` (or `Enter` on the header) open and close a
category; the state is kept while switching views, and a search shows matches
in closed categories too. The filter `f` and search `/` apply before grouping.

The Chat view's agent list (`6`) uses the same categories and keys, with its
own open/closed state. It lists only agents that take messages (native and
local Claude). The agent picker (`Tab` in a chat) and the new-task dialog
list the agents in the same category order.

## Ops Floor (2D plan)

`9` opens the Ops Floor: the web page's 2D plan (`/ai-agents/ops-floor`) in
the terminal, with the same rooms, seats, statuses and links
(`frontend/src/lib/opsFloor/config.ts` and `model.ts`, mirrored in
`src/floor.rs`). Seats must be moved in both places.

- Each agent is a card at its desk with status, what it does now (tool and
  target, task text masked), and running/queued tasks or open approvals.
  Status follows the web order: Error, Needs approval, Paused, Working, Idle.
  A working card says what the last live event was: starting, running a tool,
  thinking, delegating, reviewing results; a finished task shows Completed
  for 5 seconds.
- Lines are drawn only for real relations: active delegations always (blue,
  yellow for approval, red for error), the configured routes only for the
  selected agent. Work moving right now (`delegated`/`returned` events) is a
  cyan line with an arrowhead and a moving packet.
- Every agent has its figure from the web page (Tux for the Coordinator, the
  red hat for Linux …): small on every card (beside the status, under it on
  narrow cards, a 2-cell chip on very low ones), and as the full 16×16
  portrait in the detail panel. Drawn with half blocks, so it needs a
  true-colour terminal. Beside the name is the role icon from the web cards
  as a one-cell symbol (`⎇` Coordinator, `❯` Linux, `◈` Security …).
- Agents without a seat go to the room **Other**, and local Claude agents to
  **Local Claude**, so nobody disappears.
- `← ↑ ↓ →` move to the nearest desk in that direction, `j`/`k` in reading
  order, a click selects a card and a second click opens it. `Enter` shows the
  agent's details, or its approval if it waits for one; `a` opens its
  approvals. `m` `n` `l` `x` `f` `/` work as in the Agents view; the filter
  and search dim agents and never move them.
- From 130 columns there is a detail panel (room, status, peer, tool,
  approvals, error, routes, recent activity). Below about 84×18 the floor is a
  list, room by room.

## Local Claude Code agents

One Claude agent, **Claude-external**, is in the agent list from start, so
you can message it right away; its process starts with the first message.
Set `claude_default_agent` to another name, or to `""` to turn it off.
Right-click anywhere (or press `C`) and choose **New Claude agent** to start
more Claude Code agents on this host. It appears in the agent list as "Claude 1",
"Claude 2" … next to the Ops-Center agents, with status, active task, live
tool calls, chat and its cost in the bottom line. Start several to run tasks
in parallel. Messages sent while an agent works are queued, as in the CLI.

- Each agent is one `claude -p` process speaking stream-json, with your own
  account, settings, CLAUDE.md rules, MCP servers, skills and permission mode
  (`auto` by default), started in `claude_dir`. It stays up between messages;
  if it ends, the next message resumes the session (`--resume`). The agent
  details show `claude --resume <session>` to continue in a terminal.
- **Permission prompts work as in the CLI.** When Claude needs approval for a
  tool call it waits, and the request appears first in Approvals (and on the
  dashboard approval panel) with the exact input: `a` allow, `A` allow and
  keep Claude's suggested rule, `r` deny, `o` details.
- **Questions** (AskUserQuestion) open a dialog: pick an option (Space for
  multi-select) or type an answer, Enter sends. Esc leaves it in Approvals.
- `x` interrupts the running task without ending the session. Right-click a
  Claude row for chat, stop and close.
- Configuration (`config.toml`): `claude_bin` (default `claude`),
  `claude_dir` (default `.`, the directory opstui starts in),
  `claude_permission_mode` (default `auto`), `claude_default_agent`
  (default `Claude-external`, empty = none).
- These agents exist only while opstui runs and are not registered in
  Ops-Center, so the web GUI does not show them, and their cost is not part of
  the Ops-Center budget. Prompts go over stdin, not the command line.
- Not available (CLI-only): slash commands such as `/clear` or `/model`,
  pasting images, rewinding a conversation.

## Approvals and safety

- Selecting a row never changes anything. Every write is an explicit key and
  goes through a confirmation dialog. Level-3 or high-risk actions, patch
  approval, patch rejection and production releases also require typing a
  word (`approve`, `reject`, `release`).
- **Agent actions** (`/ai/actions`) are approved or rejected by the backend's
  `decide_action`. It writes the audit entry and checks the operator or admin
  role and the approval level.
- **Developer changes** follow the existing workflow, and every step is its
  own operation:
  1. *Approve development* (`/ai/proposals/{id}/approve`) only starts the
     developer agent.
  2. *Approve the patch* (`/ai/proposals/{id}/review`) sends the SHA-256 that
     opstui computes over the diff on screen, and only if it equals the hash
     the backend reports for the stored patch. The backend refuses if the
     patch changed since then. The diff is shown unmasked: what you approve is
     exactly what you saw. It needs a password confirmed in the last 5 minutes, and opstui
     prompts for it (`/auth/reauth`).
  3. *Record production release* (`/ai/proposals/{id}/deployed`) is
     bookkeeping after a reviewed release, and also requires a recent
     password confirmation. opstui deploys nothing.
- opstui never approves anything on its own and has no database access. The
  backend's RBAC decides every request: viewers can read, and the backend
  refuses writes they are not allowed to make.

## Data sources

| Panel | Endpoint |
| --- | --- |
| Agents, counts | `GET /ai/agents`. `running_tasks`/`queued_tasks` count tasks per agent, so 12 tasks on one agent show as one working agent with 12 tasks |
| Tasks, queue, active task | `GET /ai/tasks`, `GET /ai/tasks/{id}/board` (steps, approvals), `POST …/cancel`, `POST …/resume` |
| Approvals | `GET /ai/actions?status=pending`, `GET /ai/developer/overview`, `GET /ai/developer/changes/{id}`, `GET /ai/proposals/{id}/patch` (admin) |
| Live activity, logs | SSE `GET /ai/agents/stream` (tool calls, delegation, approvals, errors) |
| CPU / RAM | `GET /metrics/hosts` (Prometheus), `GET /health` |
| Chat | `POST /ai/ask` with the web chat's `conversation_key` format, `GET /ai/history` |
| History | `GET /ai/history`, `GET /ai/tasks`, developer changes, `GET /audit` (admin) |
| AI traffic | `GET /ai-traffic/overview`, `GET /ai-traffic/events` (operator, read-only) |

## Backend gaps (shown, not simulated)

- **Event replay:** the stream has no event IDs. After a reconnect, opstui
  re-reads all state over REST and drops the stream's replay of unchanged
  agent states, but activity that happened during the outage is not shown in
  the live log. The tasks and history views still contain it. Fixing this
  would need a backend change (a Redis stream with IDs and `Last-Event-ID`).
- **Pause and resume of a running task:** the backend has no pause. opstui
  offers stop (cooperative cancel), plus resume of finished investigations
  the backend marks as resumable.
- **Task priority:** tasks have no priority field, so the queue shows status
  instead.
- **GPU:** the metrics API exposes no GPU series. The tile says `unavailable`.
- **Per-agent token use:** usage exists only per model and day
  (`/ai/usage`), so the agent view shows no token counts.
- **Test results:** Ops-Center never runs model-written code. The Tests tab
  shows the backend's own checks (credential scan, path allowlist, tests
  included, "not run").
- `ops-center tui`: there is no existing `ops-center` CLI to extend, so
  `opstui` is the command.

## Development

```
src/api.rs     REST client: login, refresh (cookie + CSRF header), reauth, retry on 401
src/sync.rs    background work: snapshots, SSE stream with reconnect, write operations
src/app.rs     state and keyboard/mouse handling
src/ui.rs      rendering (theme, layouts, panels)
src/floor.rs   Ops Floor data: rooms, seats, status, motion, links
src/ui/floor.rs Ops Floor 2D plan rendering
src/model.rs   backend data shapes
src/mask.rs    hides credentials before display and logging
tests/         mock backend (auth, refresh, reauth, SSE drops) and app/UI tests
```

The terminal event loop never waits on the network. Fetches and writes run as
Tokio tasks and report back over a channel. The live log keeps at most 5,000
events.
