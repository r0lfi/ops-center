# Agent collaboration

## Use in Ops Center

Open **AI Agents → Collaboration settings** as an administrator. Add a lead
agent and helpers, select each agent's permitted partners and diagnostic tools,
edit budgets and rules, and enable collaboration. Save applies a versioned
policy update; a conflicting edit requires reloading. Updates and stop requests
are audit logged.

Open **AI Agents → Collaboration board**, choose a lead agent and describe the
problem. Each investigation gets its own owner-only board. Agents can post
evidence, read recent contributions and request help directly from a permitted
peer. Questions and answers are recorded automatically. Only the addressed
helper runs, one at a time; a helper may ask another helper within the configured
depth. The lead combines the results. Ordinary chat, Talk and scheduled jobs are
not automatically enrolled.

Settings include task/daily token budgets, maximum output, model calls, messages,
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
model/tool calls. Peer posts are untrusted evidence.

## Budget accounting and stop behavior

The same task ID follows lead and helper calls. A PostgreSQL transaction locks
settings, the daily ledger and the board in that order, reserving input plus an
output cap before contacting a provider. Global daily accounting includes all
users' collaboration investigations and resets by UTC date. Concurrent callers
cannot spend the same remaining reservation capacity.

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

## Storage and first release scope

Migration 0037 adds settings, boards, posts, daily usage and reservations. It is
additive and seeds collaboration disabled, with no agent grants. No existing
settings or data are rewritten. API creation uses source=collaboration and the
existing Celery AI queue. The runtime carries a context-local session through
nested agent calls; no new service or network is required.

This release provides persistent task conversations, not an always-running
asynchronous forum. Cross-investigation knowledge promotion, multiple concurrent
helpers inside a board, automatic retention and exact monetary budgets are not
implemented. Boards remain in the owner's archive. Diagnose in the board and
request any operational change through the existing approval workflow.

## Validation

The isolated PostgreSQL suite exercises three-agent dialogue, actual worker
runtime integration, shared and concurrent reservations, stops/revocations,
provider usage anomalies, peer/cycle/deduplication checks, API ownership and admin
checks, global activity privacy, and migration upgrade/downgrade. Provider and
infrastructure calls are mocked; the database, locking and API behavior are real.

Run from the repository root against a disposable database whose name is exactly
ops_collaboration_test:

    COLLAB_TEST_DATABASE_URL='postgresql+psycopg://postgres@/ops_collaboration_test?host=/tmp/ops-collaboration-pg' PYTHONPATH=backend:. python -m pytest worker_ai/tests backend/tests -q

Without the database variable, PostgreSQL integration tests are skipped.
The frontend is checked with npm run build.

## Design references

- [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html):
  FOR UPDATE serializes admission and ledger changes across workers.
- [Celery task delivery and idempotence](https://docs.celeryq.dev/en/latest/userguide/tasks.html):
  task delivery alone is not a substitute for an application-level claim.

## Deployment and rollback

Build API, AI worker and frontend images from canonical internal Git. Deploy one
API first so its entrypoint applies the additive migration, then deploy the other
API and workers. Recreate only those services on existing networks. Check active
AI jobs before worker recreation. Retain prior image IDs/tags and verify running
file hashes and health on both nodes.

Rollback application images without dropping the new tables; old code ignores
the additions. Do not downgrade a populated production database merely to roll
back the application. A manual downgrade removes collaboration data.
