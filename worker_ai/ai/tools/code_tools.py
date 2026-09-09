"""
Read-only access to the Ops Center git repository itself, for the General
Agent to answer "why does X behave like that" by actually reading the
code instead of guessing.

Safety boundary: a path is readable only if `git ls-files` lists it -
i.e. only files actually committed to the repo. .env, anything under
secrets/, and any local/build artifact are never tracked (see
.gitignore), so this can't leak them regardless of what path is asked
for - deliberately not a denylist of "sensitive-looking" names, which is
exactly the kind of check that's easy to get wrong.

REPO_ROOT is bind-mounted read-only into this container (see compose.yml,
ops-ai-worker's `repo` volume) - worker_ai's own Docker image otherwise
only ever COPYs specific files in at build time, no live source tree.
"""
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(os.environ.get("REPO_ROOT", "/repo")).resolve()
_MAX_CHARS = 20000
_MAX_MATCHES = 40


def _tracked_files() -> set[str] | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files"], capture_output=True, text=True, timeout=10, check=True
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return set(result.stdout.splitlines())


LIST_FILES_SCHEMA = {
    "name": "list_repo_files",
    "description": (
        "Lists files in the Ops Center git repository matching a path prefix or substring (e.g. "
        "'worker_ai/ai/tools' or 'compose.yml'). Only files actually committed to the repo are "
        "visible - never .env or anything under secrets/."
    ),
    "parameters": {
        "type": "object",
        "properties": {"pattern": {"type": "string", "description": "Path prefix or substring to filter by"}},
        "required": ["pattern"],
    },
}

READ_FILE_SCHEMA = {
    "name": "read_repo_file",
    "description": (
        "Reads one file from the Ops Center git repository by its path relative to the repo root "
        "(e.g. 'worker_ai/ai/runtime.py'), capped at ~20k characters. Returns available=false for "
        "any path that isn't a tracked file - use list_repo_files first if unsure of the exact path."
    ),
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
}

SEARCH_CODE_SCHEMA = {
    "name": "search_code",
    "description": (
        "Searches the Ops Center repository's tracked files for a literal string or simple regex, "
        "returning matching file:line:text triples (like grep -n). Use this to find where "
        "something is implemented before reading the whole file."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "path_prefix": {"type": "string", "description": "Optional - limit to files under this path"},
        },
        "required": ["query"],
    },
}


def list_repo_files(pattern: str) -> dict:
    tracked = _tracked_files()
    if tracked is None:
        return {"available": False, "error": "repository is not accessible from this worker"}
    matches = sorted(f for f in tracked if pattern in f)
    return {"available": True, "count": len(matches), "files": matches[:200]}


def read_repo_file(path: str) -> dict:
    tracked = _tracked_files()
    if tracked is None:
        return {"available": False, "error": "repository is not accessible from this worker"}
    normalized = path.strip().lstrip("/")
    if normalized not in tracked:
        return {"available": False, "error": f"{path!r} is not a tracked file in this repository"}
    full = (REPO_ROOT / normalized).resolve()
    if not str(full).startswith(str(REPO_ROOT) + os.sep):
        return {"available": False, "error": "invalid path"}
    try:
        text = full.read_text(errors="replace")
    except OSError as exc:
        return {"available": False, "error": f"could not read {path!r}: {exc}"}
    truncated = len(text) > _MAX_CHARS
    return {"available": True, "path": normalized, "truncated": truncated, "content": text[:_MAX_CHARS]}


def search_code(query: str, path_prefix: str = "") -> dict:
    if not str(REPO_ROOT).startswith("/") or not REPO_ROOT.exists():
        return {"available": False, "error": "repository is not accessible from this worker"}
    cmd = ["git", "-C", str(REPO_ROOT), "grep", "-n", "-I", "-i", "--max-count", "5", "-e", query]
    if path_prefix:
        cmd += ["--", f"{path_prefix.strip('/')}*"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "error": f"search failed: {exc}"}
    if result.returncode not in (0, 1):  # 1 = no matches, still a valid result
        return {"available": False, "error": result.stderr.strip()[:300] or "search failed"}
    lines = [line for line in result.stdout.splitlines() if line]
    return {"available": True, "query": query, "match_count": len(lines), "matches": lines[:_MAX_MATCHES]}
