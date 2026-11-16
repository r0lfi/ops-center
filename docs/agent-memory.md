# Agent memory

Ops Center archives submitted web messages and agent responses in its own PostgreSQL HA database. Personal notes are stored in `ai_memories`; `ai_memory_preferences` controls whether the authenticated user's agents may use long-term memory. No external vector store or embedding service is used.

Web tasks carry the authenticated user's immutable ID. Migration 0033 links existing web tasks to the matching current account only when that account predates the task, so a reused username does not inherit an older account's history. Personal notes and the new history endpoints always filter by this ID. Existing administrator-oriented task/audit pages retain their existing permissions.

All web agents, including delegated agents, receive task-bound personal-memory tools. Each agent reads shared notes plus notes scoped to its own immutable agent ID. Delegated agents use their own scope, not the parent agent's. The same key may exist independently in shared and specialist scopes. Tool calls select `shared` or `agent`; the current agent ID is supplied by the runtime, never by model arguments. Existing notes stay shared after migration 0034. A model can save explicitly provided facts/preferences with `remember_fact` and search notes or older completed conversations with `recall_memory`. The model's tool arguments cannot choose another user. Notes are not automatically extracted by a second model call. Existing archive messages remain searchable, including older messages that have no saved note.

Each request includes at most six prior completed exchanges with the same agent, truncated to 2,000 input / 3,000 response characters each, plus action outcomes. Up to twelve recent personal notes are included, truncated to 600 characters each. An explicit recall returns up to four historical exchanges and eight matching notes. The archive remains local; these selected excerpts are transmitted to the configured model provider when used. Delegated agents may use different providers. Local storage therefore does not imply local inference or zero retention at a provider.

History & memory lets users search/reopen their own conversations, add/edit/delete notes, and disable long-term memory. “Notes for” selects shared notes or one agent; creation and editing stay in that scope. Domain knowledge and routines can be saved for a specialist. Notes do not grant tools, permissions or approval to perform actions. Scope controls direct note retrieval, not confidentiality: the existing user-owned archive remains searchable across agents, and delegated answers can convey relevant information to their caller. Disabling memory preserves saved data, hides personal memory tools and notes from future requests, and restricts automatic history to the same conversation key. New conversation creates a new thread, not a data-deletion request. Deleting a note does not erase its original archived conversation, tool trace, audit log or backup. The prompt instructs agents not to reconstruct deleted notes from archived text; disable long-term memory to prevent archive retrieval as well.

Personal memory is available to authenticated web tasks and explicitly linked Talk tasks. Talk binds the signed `users/<id>` actor plus an approved private room token to an immutable Ops Center user ID through `TALK_MEMORY_BINDINGS`. Display names never establish ownership. The worker rechecks the binding and active account before enabling memory. Talk history stays scoped to room and owner; unlinked tasks cannot retrieve linked tasks. Old Talk tasks are not retroactively assigned by display name. Scheduled/unowned tasks do not receive private memory. Explicitly enabled IM investigations are bound to the configuring active administrator, a durable incident/task link and the current automation configuration. They may use that owner's memory only while the preference is enabled; revocation and incident state are rechecked during execution. No network device or operating-system command is authorized by historical text; existing approval checks still govern operational tools.

## Personal agent (nova)

Nova ([nova.md](nova.md)) uses the same memory as every agent: shared notes plus notes in its own scope, owned by the task's user. Its tasks are visible only to their owner, no other agent can delegate to it, and it can only delegate to the Coordinator, so personal context does not travel into infrastructure tasks beyond the subtask Nova writes. With memory disabled, Nova receives no notes or earlier conversations, makes no suggestions and writes no journal. Nova may only *suggest* observations; the owner accepts or rejects them under AI Agents → Nova → Suggestions (see [nova.md](nova.md#learning-about-the-owner-phase-2)). Keys with a reserved prefix (`app/core/memory_rules.py`) are excluded from the twelve automatic note slots like the imported `claude.*` notes.

Notes have an optional category and kind (fact, plan, history; migration 0056). `recall_memory` can be limited to one category, and `remember_fact` accepts both. Every change to an existing note - by the owner, an agent overwriting a key, an import or an accepted update - stores its previous state in `ai_memory_versions`, so History and Recently deleted can restore it. See [nova.md](nova.md#organized-memory) for Import & Organize and the memory index personal agents receive.

Nova routines run as tasks with `source="routine"` (migration 0057). `memory_owner` accepts them only while the run belongs to the owner's routine and the owner has proactive runs and memory on; such a run gets `recall_memory` but cannot save or suggest notes. See [nova.md](nova.md#proactive-routines-phase-3).

Personal agents can also read the owner's configured calendar and Home Assistant sources (`NOVA_DATA_SOURCES`), only on tasks whose `memory_owner` is that source's owner; see [nova.md](nova.md#data-sources-phase-5).

## Deployment

Apply migrations through 0034 to the shared database before starting the new API and AI-worker code. Migration 0034 adds a nullable agent scope and replaces note uniqueness with `(user_id, agent_id, key)` using PostgreSQL 15+ NULLS NOT DISTINCT. It only adds tables, a nullable ownership column and an index, then links eligible historical tasks. Roll API/frontend nodes one at a time and restart AI workers only after current tasks have finished. Both HA nodes must have the same Git tree. Deploy the API and all AI workers before exposing the new frontend so old workers cannot read specialist notes as shared notes. Once specialist notes exist, do not roll back to an unscoped worker/API: it would treat all notes as shared. Migration 0034 refuses downgrade while specialist notes exist, to prevent losing their scope. Preserve notes and fix forward or disable memory before an application rollback.


## Troubleshooting experience

Owned IM investigations reuse up to four prior investigations for the same resource or rule, with archived analysis, timestamps, source state and up to six actual action statuses each. The context distinguishes unverified analysis, attempted/failed/executed actions and independently observed recovery. It does not infer that an action caused recovery or convert logs into personal notes. Existing web and linked Talk conversations remain searchable through `recall_memory`, so experience predating IM automation is also available. Automatic task prompts explicitly request this search before repeating troubleshooting.

The archive itself is the durable experience record; no extra extraction model call or external vector database is required. Disabling owner memory prevents prior incident context and memory search while preserving data. The IM settings panel reports whether memory is enabled for its configured owner.

## Imported Claude Code memory

The owner's Claude Code memory (one Markdown file per fact, plus the
`MEMORY.md` index) can be imported as shared notes, so every agent can use the
same infrastructure history: hosts, services, past incidents and fixes.
`scripts/admin/import-claude-memory.py` runs inside `ops-api`. The logic is in
`app/services/claude_memory_import.py`:

    docker compose cp <claude-memory-dir> ops-api:/tmp/claude-memory
    docker compose cp scripts/admin/import-claude-memory.py ops-api:/tmp/
    docker compose exec ops-api python3 /tmp/import-claude-memory.py --owner admin --dir /tmp/claude-memory --dry-run
    docker compose exec ops-api python3 /tmp/import-claude-memory.py --owner admin --dir /tmp/claude-memory
    docker compose exec ops-api rm -rf /tmp/claude-memory /tmp/import-claude-memory.py

Each file becomes one or more shared notes keyed `claude.<name>.<nn>`. Chunks
stay under recall's 1000-character excerpt, and lines matching the
credential pattern are dropped. Re-running is a sync: unchanged notes are
untouched, changed notes are updated, and `claude.*` notes whose source
disappeared are deleted. The user's own notes are never touched. The
`claude.` prefix is reserved, so `remember_fact` refuses it.

Several hundred imported notes would otherwise take all 12 automatic
note slots. They are therefore excluded from the automatic context. Each
request instead states how many exist, and agents reach them with
`recall_memory`. Recall now requires every word of the query to match (in any
order, at most 8 words), rather than one contiguous phrase, so "docker-02
nextcloud" finds a note that mentions both. Imported notes are dated
reference data and must be rechecked against current state.
