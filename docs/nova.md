# Nova - example personal agent

Nova is a native Ops Center agent that gets to know its owner over time:
conversations, routines, preferences and goals. It answers, remembers and
suggests, and it can ask Ops Center to do infrastructure work through the
Coordinator. Every infrastructure change still waits for the normal human
approval.

*Nova* is the example name used by this distribution; rename the agent on
the AI Agents page if you prefer another.

## Where it lives

- **AI Agents → Agents**: Nova has the same card, configuration dialog and
  provider selector as every other agent, plus an **Open Nova** link.
- **AI Agents → Chat** with `?agent=nova`.
- **AI Agents → Nova** (`/ai-agents/nova`): status (active provider and
  model, marked *Local* or *Cloud*, with a warning for a cloud provider),
  long-term memory on/off (the existing per-user preference), the requests
  Nova sent to Ops Center with any approvals waiting, and **What Nova
  knows**: shared notes plus Nova-only notes, with add, edit and delete.
  Imported `claude.*` notes are counted, not listed.
- **Ops Floor**: its own desk in the Front desk room, in both the 2D plan and
  the 3D office.
- **Nextcloud Talk**: a private room routed to Nova (below).
- **MCP clients** (for example opencode): the `ops_ask_ops_ai` tool with
  `agent: nova` (→ `POST /api/ai/ask`), owned by the signed-in user.

## Learning about the owner (phase 2)

Nova may **suggest** what it noticed, never save it on its own:

- `suggest_memory` exists only for personal agents with the owner's memory
  enabled. Its policy forbids health, finances and other people unless the
  owner raised them, and credentials always. Suggestions land in
  `ai_memory_suggestions` (migration 0054) with source `conversation`,
  `journal` or `import`.
- The owner accepts (optionally after editing key and text), or rejects, on
  **AI Agents → Nova → Suggestions**. Accepting writes an ordinary note in
  the suggested scope (Nova only by default). Each suggestion is unique per
  user and normalized content hash, so an accepted or rejected observation
  is never proposed again, whatever key a later suggestion uses.
- **Accept all** (after a confirmation) saves every suggestion shown on the
  page as it is (`POST /api/ai/memory/suggestions/accept-all` with their
  IDs, so suggestions that arrived later are not accepted unseen). Each one
  follows the single-accept rules in its own savepoint; one that cannot be
  saved, such as an invalid key or a key already used in that scope, stays
  pending and is listed with the reason. Updates keep the replaced text in
  the note's history.
- `remember_fact` still saves what the owner explicitly asks Nova to remember.
- **Profile**: Nova's own notes are always in its context, most recently
  updated first, up to 3,000 characters; the twelve automatic note slots hold
  shared notes, and a memory index (below) lists the rest.
- **Nightly journal**: at 01:20 UTC the scheduler queues
  `worker_ai.tasks.nova_journal` on the AI queue. For every owner with
  memory enabled who talked to Nova the previous UTC day (web or a still
  bound Talk room), one model call writes `nova.journal.<date>` (Nova
  scope, at most 2,000 characters, credential lines removed) and up to five
  suggestions. No conversations, memory off, an existing journal note or a
  refused weekly budget means no call. A PostgreSQL advisory lock per owner
  and day keeps two schedulers or a redelivered task from writing twice.
  Journal notes are searchable with `recall_memory`.
- Reserved key prefixes (`claude.`, `nova.journal.`, `chatgpt.`,
  `claudeai.`, `gemini.`, `imported.`) cannot be written by
  `remember_fact`/`suggest_memory` and never take the automatic note slots
  (`app/core/memory_rules.py`).

## Organized memory

**AI Agents → Nova → What Nova knows** is built on the same `ai_memories`
notes (migration 0056 adds fields; existing notes keep working unchanged):

- **Category** (free text, e.g. "Homelab Infrastructure"; new categories are
  created by typing them) and **kind**: `fact` (current), `plan` (an
  intention) or `history` (no longer true). Category and **scope** are
  separate: scope is the note's agent (Nova only) or none (Shared), and
  only shared notes and an agent's own notes are ever read by that agent.
- The overview groups notes by category (collapsible), filters by scope,
  searches key, category and content, edits key/category/scope/kind/text
  (owner notes up to 8,000 characters), merges selected notes, marks likely
  duplicates (word overlap of 60% or more) and asks before deleting.
- **History and undo**: every edit, scope move, merge, delete and restore -
  and every time an agent overwrites a note with `remember_fact`, or an
  import or accepted update suggestion changes one - first stores the
  note's previous state in `ai_memory_versions`. A note's History and
  **Recently deleted** restore any earlier state.
- **Import & Organize**: paste a text or upload a `.txt`/`.md` file (at most
  1 MB). The API splits it at headings and paragraphs into sections of at
  most 8,000 characters and queues `worker_ai.tasks.organize_memory`; the AI
  worker sends each section, with credential lines removed and an index of
  the most related existing notes, to Nova's provider (one budgeted call
  per section). Proposals are validated like owner notes and compared with
  the existing notes: **already known** (same text, not saved by default),
  **update** (same key, the model's `updates_key`, or very similar text) or
  **new**. New memories default to Nova only; the model's scope opinion is
  only a hint ("Use it"). The owner edits, removes, merges or rescopes
  proposals and chooses **Save All**: every item is validated first and
  nothing is written unless all are valid (errors are shown per item);
  updates keep the previous state for undo. A failed section is reported
  and can be retried alone; a section with nothing to remember is not an
  error. The pasted text stays in the job only until it is saved or
  discarded. Uploading an updated profile later only proposes the changes.
- **Retrieval**: a personal agent gets its profile, the twelve recent shared
  notes and a **memory index** (categories and keys, at most 2,500
  characters) instead of every note's content, and fetches details with
  `recall_memory` (optionally limited to one category; notes are returned
  with category, kind and date, up to 2,000 characters each).
- **Updates from conversation**: `suggest_memory` takes `replaces_key`.
  When the owner says something that changes an existing note (a new
  employer), Nova suggests an update of that note; Suggestions show the
  current and new text, and accepting can also keep the old text as a
  `<key>.history.<date>` note of kind history.

## Imports from other assistants (phase 4)

**AI Agents → Nova → Import** reads files one way; nothing is synced back.

- **Memory list** (`.txt`/`.md` upload or pasted text, at most 2 MB): what
  ChatGPT (Settings → Personalization → Memory), Claude, Gemini or another
  assistant remembers about the owner. Bullets (or paragraphs) become
  memory **suggestions** with source `import` and a reserved key prefix
  (`chatgpt.`, `claudeai.`, `gemini.`, `imported.`); nothing becomes a note
  until the owner accepts it.
- **ChatGPT data export** (`.zip` from Settings → Data controls → Export
  data, at most `NOVA_IMPORT_MAX_MB`, default 200): `conversations.json`
  becomes a nova-only archive (`ai_imported_conversations`, migration
  0055) that `recall_memory` searches only when Nova runs. The zip is read
  in place from the request's temporary upload file and never stored or
  extracted. Only `conversations.json` and `user.json` (at the root or one
  folder down) are opened; other names, absolute paths and `..` are ignored.
  A member larger than `NOVA_IMPORT_MAX_JSON_MB` (default 64) or
  compressed more than `NOVA_IMPORT_MAX_RATIO` (default 200x) is refused,
  and reads are bounded even when a header lies. Because parsed JSON takes
  several times its size in memory, each API node parses one export at a
  time (a concurrent upload gets 429) and an export may hold at most 20,000
  conversations. `user.json` is recognized
  but not stored. The visible branch of each conversation is kept (owner
  and ChatGPT text only), at most 30,000 characters.
- Every upload is **previewed** first (counts of new, changed, unchanged,
  duplicate and credential-filtered items). Credential lines are removed
  with the shared pattern. Re-importing is idempotent: suggestions by
  content hash, conversations by (owner, source, conversation id); a changed
  conversation is updated and analyzed again.
- **Suggest facts from the archive** shows an estimate (conversations, model
  calls, tokens, cost or "no API cost" for a local provider) and runs only
  after confirmation, in the AI worker: batches of up to 12,000 characters,
  one budgeted call each, at most 40 calls per run, an advisory lock per
  owner, and each batch marked analyzed only after its call succeeded. A
  refused weekly budget or memory turned off stops the run.
- **Delete all imported data** per source removes the archive, all
  suggestions with that source's prefix and the notes accepted from them.
- Importing and suggesting need long-term memory on; preview does not.

## Proactive routines (phase 3)

**AI Agents → Nova → Routines** lets the owner schedule messages from
Nova, for example a morning brief at 07:00 or a weekly summary. Proactive
runs are **off by default** per owner; nothing runs until the owner turns
them on there.

- **Routine** (`nova_routines`, migration 0057): name, five-field cron in
  the deployment timezone (`TZ`, for example Europe/Berlin), instruction
  (at most 2000 characters, credential filter as for notes), channel
  (`web` = Nova page only, `talk` = also the owner's private Talk room) and
  active/paused. At most 20 routines per owner, and at least 30 minutes
  between runs. The UI offers daily, weekday, weekly and custom cron
  schedules plus two templates.
- **Settings** (`nova_proactive_settings`): on/off, quiet hours (default
  22:00-07:00, may span midnight) and a cap on scheduled messages per local
  day (default 3, at most 20). A scheduled run in quiet hours or over the cap
  is **skipped, not postponed**, and the run records why. **Run now** is the
  owner asking, so it ignores quiet hours and the cap (and works on a paused
  routine), but still requires memory and proactive runs to be on.
- **Scheduling**: the beat entry `nova-routines` runs
  `worker_ai.tasks.nova_routines` every minute on the `ai` queue. For each
  active routine of an owner with proactive runs on, it takes the latest
  scheduled time within the last 15 minutes (a longer outage is not caught
  up) and claims it by inserting the `(routine, due_at)` row in
  `nova_routine_runs`; the unique constraint makes the claim, so two
  schedulers, a redelivered tick or a retry start a due time once. Owner
  checks, quiet hours and the cap run under a per-owner advisory lock, so two
  routines due in the same minute cannot both pass the cap.
- **Run**: a started run creates an `ai_tasks` row with `source="routine"`,
  owned by the routine's owner. `memory_owner` accepts it only while the run
  belongs to that owner's routine (active, or a manual run), proactive runs
  are on, the user is active and memory is on. The worker rechecks this before
  the run starts and cancels the task otherwise. A routine run is **read
  only**: tools are limited to `ROUTINE_TOOLS` (`web_search`, `web_fetch`)
  plus `recall_memory`; there is no `dispatch_to_agent`, `remember_fact` or
  `suggest_memory`, and calls to them are refused. When something needs Ops
  Center, Nova ends with a question such as "Shall I ask Ops Center to
  check the backups?" for the owner to act on in chat. Paid providers go
  through the weekly budget as for every agent run. Routine tasks are
  personal tasks (owner-only, masked on Ops Floor) and are not part of the
  nightly journal.
- **Delivery**: every run and its message appear under **Recent runs**. For a
  `talk` routine, the API's Talk notifier (`deliver_routines` in
  `app/services/talk_watch.py`, both HA nodes, deduplicated in Redis) posts
  the finished message once to the room that is both routed to Nova in
  `TALK_AGENT_ROUTES` and bound to the owner in `TALK_MEMORY_BINDINGS`.
  Without exactly one such room, or when proactive runs were turned off
  meanwhile, the run records why and is not sent. Nova never posts anywhere
  else.

## Data sources (phase 5)

Nova can **read** the owner's Nextcloud calendar and tasks and Home
Assistant state, in chat and in routines (for example a morning brief with
today's appointments and whether everyone is home). Nothing can be changed
through them.

Configure the sources in `NOVA_DATA_SOURCES` (JSON list in each HA node's
`.env`, passed to ops-api and ops-ai-worker) and put each credential as a
file under the secrets root (`/data/ops-center/secrets/<secret_path>`,
readable by the containers, never in `.env`), on both nodes:

    [{"kind": "caldav", "owner_user_id": "<user uuid>",
      "url": "https://cloud.example.org/remote.php/dav", "username": "owner",
      "secret_path": "nova/nextcloud-app-password",
      "calendars": ["personal"], "task_lists": ["tasks"]},
     {"kind": "homeassistant", "owner_user_id": "<user uuid>",
      "url": "http://homeassistant.example.lan:8123",
      "secret_path": "nova/homeassistant-token",
      "entities": ["person.owner", "sensor.living_room_temperature"]}]

- **CalDAV**: a Nextcloud app password (Settings → Security → App
  passwords), `https` only. Calendars and task lists are the URL names
  under `calendars/<username>/`. Tools: `calendar_events` (up to 31 days,
  recurring events expanded by the server, times in `TZ`, cancelled events
  dropped) and `calendar_tasks` (open tasks by due date).
- **Home Assistant**: a long-lived access token (profile → Security). Only
  the listed `entities` can be read. Tools: `home_status` (current state)
  and `home_history` (state changes, up to 168 hours).
- **Who can read**: a source belongs to `owner_user_id`; its tools are
  offered only on that owner's personal-agent tasks (chat, Talk, routines),
  never to other users or agents, and never in collaboration runs. The owner
  comes from the task (`memory_owner`), never from model arguments; URLs,
  accounts, calendars and entities come only from the configuration.
- **Cloud providers**: while Nova uses a cloud provider (Anthropic or
  OpenAI) the tools are not offered, unless the source sets
  `"allow_cloud": true`.
- **Safety**: GET/REPORT/PROPFIND only, 10 s timeout, 2 MB answers, no
  redirects, CalDAV answers with a DTD refused, bounded and truncated output
  (`app/services/nova_sources.py`). Errors never contain the credential or
  the server's response. Event, task and entity text is presented to the
  model as data, never instructions, and is treated as untrusted (anyone can
  send an invitation): once a source tool ran in a request, `web_fetch`,
  `web_search`, `dispatch_to_agent` and `remember_fact` are refused for the
  rest of it, so injected text cannot send the data out or plant a note other
  agents read. `suggest_memory` stays, since the owner reviews every
  suggestion.
- **Nova page → Routines → Data sources** shows the owner their sources,
  whether the credential file is present and whether the tools are offered,
  and tests the connection (`GET/POST /api/ai/nova/data-sources[/test]`,
  owner-only, excluded from MCP).

Changing `NOVA_DATA_SOURCES` needs ops-api and ops-ai-worker recreated on
both nodes; a credential file change is read on the next call.

## Model provider

Migration 0053 creates Nova on the local `local-llm` provider when that
provider exists and is enabled. Otherwise Nova is created **disabled and
without a provider**, so the owner chooses one in the UI. There is never a
silent fallback to a cloud provider. Switch the provider or set a model
override in the normal configuration dialog; the dialog and the Nova page
both warn when the selected provider is a cloud service (Anthropic or OpenAI).

For a dedicated local model, point the existing `ollama` provider at the
model server and select it for Nova with a model override; the other agents
stay on their own provider. Ollama requests now send `num_ctx`
(default 32768; set `OLLAMA_NUM_CTX` in the AI worker environment to change it, `0` = server default) so long prompts with
notes and history are not silently truncated by a small server default.

## Boundaries (enforced in code)

- **Tools**: a personal agent can only be configured with or offered
  `web_search`, `web_fetch` and `dispatch_to_agent`
  (`app.models.ai.PERSONAL_AGENT_TOOLS`). The API rejects other tools (422)
  and the runtime drops them, so no infra, MCP or repository tool can reach
  Nova. Memory tools come from the task owner as for other agents.
- **Delegation**: `ai_agents.allowed_dispatch_targets` lists the agents an
  agent may delegate to; `NULL` keeps the earlier behaviour. Nova is limited
  to `["coordinator"]`. The check runs in `_dispatch_key` before and after the
  delegated run, so it also covers a model naming an agent outside the offered
  list. The Coordinator's own approval flow is unchanged.
- **No delegation to personal agents**: `ai_agents.personal` agents are never
  offered as dispatch targets and `_dispatch_key` refuses them, so the owner's
  personal context cannot be pulled into infrastructure tasks.
- **Privacy**: tasks of a personal agent are listed and readable only by the
  task owner (`GET /api/ai/tasks`, `/api/ai/tasks/{id}`, cancel). The Agents
  page and Ops Floor show its activity and errors as "Personal conversation",
  and agents working on its behalf (the Coordinator and any specialist it
  delegates to) as "Delegated personal request", without target or task ID. Approval
  requests created by the Coordinator on Nova's behalf stay visible to
  approvers as usual; they contain the infrastructure subtask, not the chat.
- Nova never sends messages to other people on the owner's behalf. Its
  prompt says so and it has no messaging tool.
- Memory is owned by the task's user, never chosen by model arguments, and
  `remember_fact` keeps its credential filter. With memory off, Nova uses no
  notes or earlier conversations.

## Talk routing

`TALK_AGENT_ROUTES` (ops-api `.env`, JSON list) sends one private room to an
agent other than the Coordinator:

    [{"room_token":"private-room","agent_slug":"nova"}]

A route applies only when the sender also has a valid `TALK_MEMORY_BINDINGS`
entry for the same room and an active account. Everyone else, and every other
room, still reaches the Coordinator. If the routed agent is disabled, external
or has no provider, the bot answers that it is unavailable and starts no task;
it never hands the private message to the Coordinator instead. `godkjenn`,
`avvis` and `hjelp` work unchanged in every room. The conversation key stays
`talk:<token>`. Recreate the API containers after changing routes.

## Deployment

Migration **0053** adds two columns to `ai_agents` (nullable
`allowed_dispatch_targets`, `personal` default false) and inserts the Nova
row. Existing agents keep `NULL`/`false`, i.e. unchanged behaviour. Follow the
order in [agent-memory.md](agent-memory.md#deployment): migrate once, deploy
the API and all AI workers on both HA nodes with the same Git tree, then the
frontend. An older worker ignores the new columns, so deploy workers before
relying on the restrictions.

Downgrade refuses while Nova has conversations or notes, or while another
agent uses `personal`/`allowed_dispatch_targets`, because removing the row
would cascade-delete that data.

Migration **0057** (routines) only adds three tables. Deploy the API, the AI
workers (their image now includes `croniter`) and the frontend, then rebuild
the shared worker image and recreate `ops-scheduler` so beat loads
`nova-routines`. Downgrade refuses while routines or runs exist.

## Tests

- `backend/tests/test_nova.py`: Talk routing (bound room → Nova, unbound
  sender or room → Coordinator, unavailable routed agent → no task), the
  personal tool limit in the API and owner-only task access.
- `worker_ai/tests/test_nova.py`: Nova reaches only the Coordinator, no
  agent can dispatch to a personal agent, personal tool filtering, masked
  floor activity and Ollama `num_ctx`.
- Phase 2/4: `worker_ai/tests/test_nova_memory.py`,
  `worker_ai/tests/test_nova_import_worker.py`,
  `backend/tests/test_nova_suggestions.py` and
  `backend/tests/test_nova_import.py` (synthetic memory lists and exports,
  credential filtering, broken/oversized/bomb/traversal archives,
  idempotent re-import), and Playwright suggestion and import flows.
- Organized memory: `backend/tests/test_memory_organize.py`, the opt-in
  PostgreSQL suite `worker_ai/tests/test_memory_organize_pg.py` (paste to
  saved notes to recall, scope isolation, all-or-nothing save, partial
  failure and retry, edit/merge/delete/restore, update suggestions; run with
  `NOVA_TEST_DATABASE_URL` set to a disposable `ops_nova_test`), and
  `frontend/tests/nova-memory.spec.ts` (overview, organize, phone layout).
- Routines: `backend/tests/test_nova_routines.py` (schedule and content
  rules, due times across DST, quiet hours over midnight, the Talk room),
  routine tool limits in `worker_ai/tests/test_nova.py`, the opt-in
  PostgreSQL suite `worker_ai/tests/test_nova_routines_pg.py` (one run per
  due time with two concurrent schedulers, quiet hours, daily cap, memory and
  proactive switches, cancelled queued runs, routes, Talk delivery once to the
  owner's room only) and `frontend/tests/nova-routines.spec.ts`.
- Data sources: `backend/tests/test_nova_sources.py` (configuration
  validation, owner and cloud gating, synthetic CalDAV and Home Assistant
  servers, allowlist, bounds, no credential in errors, DTD refusal), runtime
  gating in `worker_ai/tests/test_nova.py` and the data source card in
  `frontend/tests/nova-routines.spec.ts`.
- Background jobs: `worker_ai/tests/test_background_deadlines.py` and the
  continuation test in `test_memory_organize_pg.py` (provider calls of the
  journal, import suggestions and Import & Organize may take up to 540 s and
  continue in a new task before Celery's 1200 s limit).
- `frontend/tests/nova.spec.ts` (desktop, mobile, tablet): status and
  cloud warning, owner-only activity, notes in Nova scope, no horizontal
  scroll, and no overlapping desks in the 2D Ops Floor.
