# Developer Agent: overview and production approval

Menu **AI → Developer Agent** (`/ai-agents/developer`) shows what the
Developer Agent is working on, what each change built, what needs a decision
and what is in production. It is built on the existing tool-proposal flow
(`ai_tool_proposals`, `worker_ai/ai/board.py`). The agent and its tools are
unchanged.

## What the page shows

| Area | Source |
|---|---|
| Live status ("Working · Analysing results") | `ai_agents.status` / `current_task` of the `developer` agent |
| Changes and their stage | `ai_tool_proposals.status`, plus the state of the developer run |
| Runs, start and finish times | `ai_tasks` with `source = development` that name the proposal |
| Changed files, lines added and removed | parsed from the stored unified diff |
| Diff | `GET /ai/proposals/{id}/patch` (admin) |
| Checks | the ones Ops Center actually performed (see below) |
| Timeline and decisions | task timestamps and the `ai_change_reviews` record |
| Network trace | the run's AI Traffic Monitor events (trace id = run id) |

The checks:
* **Credential scan** passed, because `submit_patch` refuses a credential value in any part.
* **Path allowlist** uses the same rule as `scripts/admin/apply-tool-proposal.sh`.
* **Tests included** says whether the patch adds or changes a test file.
* **Test run** is always *Not run*. Ops Center never executes model-written code, so tests run on the branch after a person applies the patch. Nothing is shown as passed that did not run.

## Stages

Proposed → Working → Ready for Review → Approved → In Production.
The other stages are Changes requested, Rejected, Failed (the developer run failed, or a recorded release failed) and Rolled back.
There is no "Deploying" stage, because Ops Center has no deploy system and does not pretend to have one.

## The approval gate

1. An admin approves a proposal for **development**. The Developer Agent writes a patch and nothing else; it has no shell or infrastructure tools.
2. The patch arrives as **Ready for Review**. Its SHA-256 is computed server-side.
3. An admin chooses **Approve**, **Request changes** (a comment is required, and the agent reruns with it) or **Reject**.
   * Each decision needs the admin role and **a password confirmed in this browser session within the last 5 minutes** (`/auth/reauth`).
   * MCP clients, agents and local script tokens have no browser session, so they can never pass the gate. The routes are also excluded from MCP.
   * An approval names the patch's SHA-256 as the reviewer saw it. If the stored patch changes afterwards, the approval no longer covers it.
   * A patch that fails the path allowlist cannot be approved.
4. A person applies the approved patch with
   `scripts/admin/apply-tool-proposal.sh <id> <patch file> <approved sha256>`. The page shows this exact command. The script refuses any other file content, applies the patch on `tool-proposal/<id>` in a separate worktree, runs nothing and commits nothing.
5. The patch is tested and released through the normal reviewed release. The admin then records **Record release** (commit or tag), **Record failed release** or, later, **Record rollback**. A release can be recorded only for an approved, unchanged patch.

Every decision is a row in `ai_change_reviews`, migration 0064. The table is append-only: a trigger refuses UPDATE. Each row holds who, when, the decision, the comment, the patch hash and the release reference. The request is also in the general audit log.

## API

| Route | Role |
|---|---|
| `GET /ai/developer/overview` | signed in; non-admins see only their own proposals |
| `GET /ai/developer/changes/{id}` | as above |
| `POST /ai/proposals/{id}/review` | admin plus a recent password |
| `POST /ai/proposals/{id}/deployed` | admin plus a recent password; only an approved change, or a proposal implemented by hand without a patch |
| `POST /ai/proposals/{id}/release-outcome` | admin plus a recent password |
