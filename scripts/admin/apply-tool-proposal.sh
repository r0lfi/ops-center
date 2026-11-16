#!/usr/bin/env bash
# Apply a developer-agent patch for an approved tool proposal on its own branch.
#
#   scripts/admin/apply-tool-proposal.sh PROPOSAL_ID PATCH_FILE APPROVED_SHA256
#
# Download the patch from AI > Developer Agent (admin) after approving it there.
# The page shows this command with the SHA-256 the approval was recorded for;
# a patch file with any other content is refused. The patch is
# model-written and untrusted until a person has read it, so this script runs
# NOTHING from it: it refuses patches outside the paths a new tool needs
# (no conftest.py, packaging, CI, scripts, compose or migrations), applies
# the patch on the branch tool-proposal/<first 8 chars of the id> from origin/main in
# a separate worktree, shows the diff and stops. Read the diff, then run the
# tests yourself and commit. No push, no deploy.
set -euo pipefail
id=${1:?proposal id}; patch=$(realpath "${2:?patch file}"); approved=${3:?approved SHA-256 from AI > Developer Agent}
[[ $id =~ ^[0-9a-f-]{36}$ ]] || { echo "proposal id must be a UUID" >&2; exit 2; }
[[ $approved =~ ^[0-9a-f]{64}$ ]] || { echo "approved SHA-256 must be 64 hex characters" >&2; exit 2; }
actual=$(sha256sum "$patch" | cut -d' ' -f1)
[[ $actual == "$approved" ]] || { echo "Refused: this patch file is not the approved patch (sha256 $actual)" >&2; exit 1; }
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
branch="tool-proposal/${id:0:8}"
worktree="${TMPDIR:-/tmp}/ops-tool-proposal-${id:0:8}"
git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && { echo "branch $branch already exists" >&2; exit 1; }
git -C "$repo" fetch -q origin main
git -C "$repo" worktree add -q -b "$branch" "$worktree" origin/main
cd "$worktree"
# Only paths a new agent tool needs. Everything else is refused before applying.
allowed='^(worker_ai/ai/tools/[a-z0-9_]+\.py|worker_ai/tests/test_[a-z0-9_]+\.py|backend/app/core/mcp_catalog\.json|docs/[A-Za-z0-9_.-]+\.md)$'
paths=$(git apply --numstat "$patch" | cut -f3)
[[ -n $paths ]] || { echo "patch changes nothing" >&2; exit 1; }
bad=$(grep -Ev "$allowed" <<<"$paths" || true)
if [[ -n $bad ]]; then
  echo "Refused: the patch touches paths outside the tool allowlist:" >&2; echo "$bad" >&2
  git -C "$repo" worktree remove "$worktree"; git -C "$repo" branch -D "$branch" >/dev/null
  exit 1
fi
git apply --check "$patch"
git apply "$patch"
git add -A
git diff --cached --stat
cat <<MSG

Applied on $branch in $worktree (not committed, nothing executed).
1. Read the whole diff:   git -C $worktree diff --cached
2. Then run the tests:    cd $worktree && PYTHONPATH=backend:. ~/.cache/ops-center-test-venv/worker_ai/bin/python -m pytest -q worker_ai/tests
3. Commit when satisfied: git -C $worktree commit -m "Implement tool proposal ${id:0:8}"
MSG
