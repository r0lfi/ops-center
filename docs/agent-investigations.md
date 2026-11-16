# Coordinated agent investigations

How the Coordinator runs an investigation, where its state lives, and what
stays a human decision. Code: `worker_ai/ai/runtime.py`, `board.py`,
`context.py`, `policy.py`; API: `backend/app/api/routes/ai_board.py`;
schema: migration `0060`.

## Flow

1. The user asks the Coordinator (web chat or Talk).
2. It checks `recall_memory`, which also returns shared findings, each marked
   `stale` once past its validity.
3. `plan_work` creates work items (`ai_work_items`): one question, one
   specialist, optional `depends_on`.
4. `dispatch_to_agent(agent, subtask, work_item)` runs a specialist. Several
   dispatches in one model turn run in parallel (up to 3, each on its own DB
   session). An item moves `queued → running → completed | inconclusive |
   failed | waiting_for_approval`, committed at every step.
5. A failing specialist marks its item `failed`; the Coordinator continues.
6. The task gets an `outcome`: `completed`, `inconclusive`, `blocked`,
   `waiting_for_approval` or `failed`. `status` only says the run ended.

Limits that stop loops: 12 work items per investigation, 2 attempts per
item, identical dispatches reuse the earlier answer, circular delegation is
rejected, depth ≤ 2, 3 `recall_memory` calls per agent run, identical reads
in one run are reused.

## Time and context

* A specialist inherits its caller's deadline minus a reserve of up to 60 s
  (25 % of what is left), so the Coordinator can always summarise. A
  specialist is not started when less than 20 s would remain.
* Coordinator: 900 s; Celery hard limit 1200 s.
* The weekly USD guard admits a request while a **byte** upper bound of its
  input stays under 180,000 (`app/services/ai_budget.py`). That is about
  45–60k real tokens and is deliberate for cost accounting; the model itself
  (Mistral Large 4) has a 1M context. Never lower the bound: `settle()` fails
  closed on it. Instead each tool result is capped at 8,000 characters and
  older tool results are trimmed once the request passes 55 % of the bound.
* `search_logs` aggregates Loki output (shared labels once, duplicates
  counted, lines ≤ 400 characters) and returns the LogQL query and range.

## Resume

`POST /ai/tasks/{id}/resume` (task owner, once) starts a new task with
`resumed_from`. The worker builds a fresh model context from the saved board
and summary, not the old transcript.

## Shared findings

`record_finding(kind, system, statement, evidence, source, valid_hours)`
writes `ai_findings`. Kinds: `fact`, `hypothesis`, `ruled_out`, `resolution`.
Identical statements update one row (fingerprint). Text matching the secret
pattern is refused. Personal agents, routines and collaboration runs do not
get these tools.

## Tool proposals and development

1. An agent that lacks a capability calls `propose_tool` (one per title while
   open, 3 per investigation).
2. An admin reviews it under **AI Approvals → Tool proposals**. *Approve for
   development* starts the `developer` agent (repository read tools and
   `submit_patch` only: no shell, no infrastructure, never a dispatch target).
3. Download the patch and run `scripts/admin/apply-tool-proposal.sh ID FILE`
   on an admin host: a new branch `tool-proposal/<id>` in a separate worktree,
   refused unless every path is on the tool allowlist (no conftest, scripts,
   compose, migrations), then applied and shown. Nothing from the patch runs
   until you have read it, run the tests and committed. No push, no deploy.
4. Release it through the normal reviewed release, then *Mark released*.
   Resume the original task to continue with the new tool.

Approval for development never deploys, never changes an agent's tools and
never grants access.

## MCP access

MCP stays inside the local network: the agents' MCP client refuses any endpoint that
does not resolve only to private addresses (`lan_only` in `worker_ai/ai/mcp_client.py`,
checked before a token is issued). Publish the MCP endpoint through your reverse proxy
only to the local network or VPN. Agents cannot use third-party MCP servers.

Agents are offered an MCP tool only while a live grant for the task owner
covers it; otherwise the run uses native tools and the prompt names the
missing access. **AI → MCP access** (`/ai-agents/mcp-access`) shows per
agent and owner: active, partly granted, expired (with date) or not granted,
and lets an admin renew for 30 days. The Agents page warns when any agent is
missing access or expires within 3 days.

## Prompts

`policy.py` holds the one shared instruction. `ai_agents.system_prompt` holds
a short role prompt per agent (migration 0060; previous prompts are kept in
`ai_agent_prompt_backup_0060` for the downgrade). Prompts are guidance only:
permissions, approvals, host scopes and budgets are enforced in code.

## Tests

* `worker_ai/tests/test_agent_reliability.py`: context, Loki, deadlines,
  reuse, recall fallback, MCP filtering, prompt injection via tool output.
* `worker_ai/tests/test_task_board_pg.py` and
  `backend/tests/test_ai_board_routes_pg.py`: full flow on PostgreSQL with a
  scripted model (set `BOARD_TEST_DATABASE_URL` to a database named
  `ops_board_test` migrated to head). These test orchestration, not model
  quality.
