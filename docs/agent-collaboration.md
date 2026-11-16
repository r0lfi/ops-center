# Agent collaboration

## Use in Ops Center

Open **AI Agents → Collaboration settings** as an administrator. Add a lead
agent and helpers, select each agent's permitted partners and diagnostic tools,
edit investigation safety limits and rules, and enable collaboration. Save applies a versioned
policy update; a conflicting edit requires reloading. Updates and stop requests
are audit logged.

Open **AI Agents → Collaboration board** and use **New investigation** to describe
the problem and choose its lead. Optional affected resources, operator severity
and context become part of the existing problem message; the total limit stays
4000 characters. Each investigation gets its own owner-only board and opens
immediately in the visual workspace.

The workspace has compact investigation navigation, a central agent floor and
a state/budget sidebar. The floor maps recorded questions to their addressed
agents and draws replies only when an exact question link exists. Short excerpts
open into full messages. The timeline, evidence/hypotheses and searchable shared
experience have separate tabs; the original problem and run limits remain in
an expandable details section. The investigation list collapses on smaller
screens and animations respect reduced motion.

Agents can post evidence, read recent contributions and request help directly
from a permitted peer. Questions and answers are recorded automatically. Each
new specialist answer links to its exact question and identifies the requester,
including nested consultations. Older answers without a recorded link stay
visible without guessing which question they answered. The lead's final response
is an investigation summary. Completion is not a claim that an operational fault
was repaired. Global activity from unrelated tasks is never attributed to this
private board.

Tool entries expose existing recorded names and arguments, in stored order.
Missing per-call timestamps, executing agent, returned results, confidence,
severity and verification steps are not inferred. Recorded collaboration,
evidence and conclusion milestones drive the progress display without percentages.
The read API adds actual task lead/start/end, tool entries, sources, confidence
and response fields; no database migration or agent execution change is involved.

Only the addressed helper runs, one at a time; a helper may ask another helper
within the configured depth. Ordinary chat, Talk, scheduled jobs and automatic
IM investigations are not automatically enrolled in a collaboration board.

The latest board opens by default. A `?board=<task_id>` URL preserves the selected
investigation through reload and links experience entries to their original
conversation. Failed detail requests clear the displayed conversation and show
an error; successful list polling does not hide that error.

All paid requests use the existing shared **USD 20 per week** allowance, including
lead and helper calls, ordinary chat and automatic IM investigations. Collaboration
does not receive a separate USD 20 bucket. The warning threshold is **USD 16 used
or reserved**, and the week resets **Monday at 00:00 UTC**. The budget card separates
estimated reported usage, reservations and remaining allowance. Settings retain
technical safety bounds for
task/daily tokens, maximum output, model calls, messages,
help requests, participants, nesting, time and concurrent investigations. Rules
can be added, edited and removed. Typed permissions decide authority; prose never
grants tools or overrides limits.

## Permission boundary

The board uses the authenticated task owner, never a user/room ID supplied by an
agent. Board list/detail/stop and the legacy task list/detail/cancel paths hide
collaboration content from other users (including other admins). Global agent
activity shows a generic collaboration status. Aggregate token usage remains
visible in the existing usage view. The shared HTTP audit log records creation
metadata without copying the private investigation prompt.

Agents have independent read, extra-post, ask and respond permissions, explicit
peer lists and diagnostic tool allowlists. Effective tools are the intersection
with existing agent tool permissions. No shell, operational action requests,
arbitrary web fetch or personal memory retrieval/write is offered. Existing
approval handling remains in ordinary chat.

All participants must have identical host and environment scopes. A scoped board
can only use supported host-specific tools with an explicit allowed hostname.
Changing a participant's scope, disabling an agent, revoking read permission or
deactivating the owner stops subsequent work. New grants do not expand a running
board's initial grants. Revocations and the master switch are checked again before
model/tool calls. New boards persist their host/environment scope so those
boundaries survive worker restarts. Peer posts are untrusted evidence.

## Experience archive and reuse

Agents may publish an explicit `experience` post containing reusable diagnostic
steps, sources, observed outcomes and uncertainty. The **Shared experience** tab
searches these posts from investigations whose board and task both completed.
Each entry retains its author, date and source-investigation link. Findings,
hypotheses and ordinary answers remain in the conversation; they are not silently
promoted to reusable experience. This is an archive of reported observations,
not proof that a current incident is fixed.

The human-readable archive belongs to the authenticated owner. It remains
searchable when that owner's long-term memory preference is disabled; the page
then explains that automatic reuse is paused. Other users, including other
administrators, cannot read that owner's archive.

For automatic reuse, `collaboration_recall` applies stricter checks. It returns
experience only from earlier, completed collaboration boards owned by the same
user and with the same persisted host/environment scope as the current board.
Historical participants must still exist, be enabled, match that scope and retain
board-read permission in both the current policy and the current investigation's
original grants. Boards lacking a verified scope snapshot cannot supply automatic
recall, and a legacy current board must be replaced by a new investigation before
it can recall experience. Results are bounded to five entries, with each content
excerpt limited to 2,000 characters or the smaller configured post limit.

The owner's memory preference is checked again when recall runs. Turning memory
off stops this reuse without deleting historical posts. Collaboration recall does
not search personal notes, private chat history or Talk conversations, and agents
cannot write to personal memory from the board. Existing personal memory tools
remain unavailable in collaboration. Recalled experience is dated reference data;
agents must recheck its relevance and sources, and it never grants tools or
operational authority.

## Budget accounting and stop behavior

The same task ID follows lead and helper calls. A PostgreSQL transaction locks
settings, the daily ledger and the board in that order, reserving input plus an
output cap before contacting a provider. Global daily accounting includes all
users' collaboration investigations and resets by UTC date. Concurrent callers
cannot spend the same remaining reservation capacity. The runtime then obtains
admission from the shared weekly USD ledger before calling the provider.

If weekly USD admission refuses the request before the provider is contacted,
the unused collaboration reservation is released: its board and daily token
charges and model-call count are restored. This release is idempotent and applies
only at that known pre-provider boundary. A provider timeout, provider error,
missing usage or worker crash does not qualify for this refund; uncertain work
continues to hold its reservation. The investigation stops with the evidence
already collected, without paying for another summary call.

Input reservations use conservative UTF-8 byte counts plus framing headroom, not
an exact provider tokenizer. Actual provider usage is reported separately.
Repeated prompts, tools and history count again on every model call. Known usage
refunds only unused output capacity, preserving conservative input charges.
Missing usage, uncertain errors and process crashes retain their reservations.
If reported usage exceeds the reservation, it is charged and further work stops.
This is an application admission budget, not a guaranteed provider invoice cap.

Explicit per-call output caps apply to all three provider adapters, including
Ollama's num_predict. Existing agent tool and time caps still apply. Lower
token/model-call caps and permission revocations affect running work; other
limits are snapshotted at start. Time/budget/message exhaustion produces a
deterministic partial evidence report without another model call.

Stop is cooperative: an already admitted model/tool request may finish; no new
step is admitted once the stop is observed. Tasks use the existing atomic queued
task claim, so duplicate queue delivery cannot start another investigation.
Unknown reservations are not retried/refunded automatically.

## Storage and runtime scope

Migration 0037 adds settings, boards, posts, daily usage and reservations. It is
additive and seeds collaboration disabled, with no agent grants. No existing
settings or data are rewritten. API creation uses source=collaboration and the
existing Celery AI queue. The runtime carries a context-local session through
nested agent calls; no new service or network is required.

Migration 0044 adds the shared monetary admission ledger. Migration 0046 adds
nullable question-reply links and persisted board scopes; existing posts and
boards remain available. Explicit experience posts reuse the existing post store.

Collaboration remains a task-driven conversation with scoped experience reuse.
It does not run an unattended forum, automatically import private notes, start
multiple simultaneous helpers inside a board or delete old boards on a retention
schedule. Boards remain in the owner's archive. Diagnose in the board and request
any operational change through the existing approval workflow.

## Validation

The isolated PostgreSQL suite exercises three-agent dialogue, actual worker
runtime integration, shared and concurrent reservations, stops/revocations,
provider usage anomalies, peer/cycle/deduplication checks, API ownership and admin
checks, global activity privacy, and migration upgrade/downgrade. Additional cases
cover exact question-reply links, cross-board reply rejection, completed-board
experience filtering, owner and scope isolation, historical participant revocation,
legacy scopes, memory opt-out and bounded literal search. The combined USD suite
checks several paid agents sharing one weekly ledger, known pre-provider refusal
refunds, idempotent releases and reservation retention after uncertain provider
attempts. Provider and infrastructure calls are mocked; the database, locking and
API behavior are real.

Run from the repository root against a disposable database whose name is exactly
ops_collaboration_test:

    COLLAB_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_collaboration_test?host=/tmp/ops-collaboration-pg' PYTHONPATH=backend:. python -m pytest worker_ai/tests backend/tests -q

For the combined collaboration/USD suite, use a separate disposable database
named exactly `ops_budget_test`:

    AI_BUDGET_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_budget_test?host=/tmp/ops-budget-pg' PYTHONPATH=backend:. python -m pytest worker_ai/tests/test_collaboration_usd.py -q

Without the corresponding database variable, PostgreSQL integration tests are
skipped. Frontend validation runs from `frontend`:

    npm run build
    npx playwright test tests/collaboration.spec.ts tests/ai-budget.spec.ts

Browser fixtures exercise linked questions and answers, legacy unlinked answers,
persistent board selection, searchable experience provenance with memory disabled,
private-detail clearing on errors, question/reply graph accessibility, responsive
layouts, new-investigation context and full-length prompts, settings/stop controls,
terminal-state history and the shared weekly budget display. They do
not contact model providers. The fixture requires a browser environment that
reports an online network interface; an isolated container with only loopback
causes the application's offline protection to hide the pages.

## Design references

- [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html):
  FOR UPDATE serializes admission and ledger changes across workers.
- [Celery task delivery and idempotence](https://docs.celeryq.dev/en/latest/userguide/tasks.html):
  task delivery alone is not a substitute for an application-level claim.

## Deployment and rollback

A change to the collaboration workspace alone touches only the API read
presentation and frontend; recreate those two services and confirm the migration
revision before and after startup.
The following procedure describes releases that also change the agent runtime.

Build API, AI worker and frontend images from canonical internal Git. Deploy one
API first so its entrypoint applies the additive migration, then deploy the other
API and workers. Recreate only those services on existing networks. Check active
AI jobs before worker recreation. Retain prior image IDs/tags and verify running
file hashes and health on both nodes.

Rollback application images without dropping the new tables; old code ignores
the additions. Do not downgrade a populated production database merely to roll
back the application. A manual downgrade removes collaboration data.
