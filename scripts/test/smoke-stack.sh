#!/usr/bin/env bash
# Start a disposable Ops Center stack from already built or published images
# and check that it actually works: health checks, web UI, API login and data
# surviving a full restart. Used by the release workflow before anything is
# published, and runnable on any Docker host:
#
#   IMAGE_PREFIX=ghcr.io/r0lfi/ops-center IMAGE_TAG=0.1.0 bash scripts/test/smoke-stack.sh
#
# Optional:
#   SMOKE_SERVICES   services to start (default: the whole stack). Dependencies
#                    start automatically, e.g. "proxy ops-worker" on a small host.
#   SMOKE_PORT       loopback port for the web interface (default 18080)
#   SMOKE_PROJECT    Compose project name (default ops-center-smoke)
#   SMOKE_VERSION    version /api/health must report (default: not checked)
#   SMOKE_KEEP=1     leave the stack running for inspection
#
# Everything is created under a temporary directory with freshly generated,
# throwaway credentials. Nothing is written to the repository or to .env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${IMAGE_PREFIX:?Set IMAGE_PREFIX, e.g. ghcr.io/r0lfi/ops-center}"
: "${IMAGE_TAG:?Set IMAGE_TAG, e.g. 0.1.0}"
PORT="${SMOKE_PORT:-18080}"
PROJECT="${SMOKE_PROJECT:-ops-center-smoke}"
SERVICES="${SMOKE_SERVICES:-}"
BASE="http://127.0.0.1:$PORT"
# Any small image with a shell works for preparing data directories.
HELPER_IMAGE="${SMOKE_HELPER_IMAGE:-docker.io/library/alpine:3.21}"

# The default project name belongs to a real installation; never touch it.
if [[ "$PROJECT" == ops-center ]]; then
  echo 'SMOKE_PROJECT must not be the name of a real installation.' >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ops-center-smoke.XXXXXX")"
DATA="$WORK/data"
ENV_FILE="$WORK/smoke.env"
ADMIN_USER=smoke-admin
ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"

compose() {
  docker compose -f "$ROOT/compose.yml" -p "$PROJECT" --env-file "$ENV_FILE" "$@"
}

log() { printf '\n==> %s\n' "$*"; }
fail() { printf 'SMOKE TEST FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    log "Service state at failure"
    compose ps -a || true
    compose logs --no-color --tail 60 || true
  fi
  if [[ "${SMOKE_KEEP:-0}" == 1 ]]; then
    log "Kept: project $PROJECT, data $DATA, env $ENV_FILE"
    return
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  # Data is owned by several container users; remove it from a container.
  docker run --rm -v "$WORK:/work" "$HELPER_IMAGE" rm -rf /work/data >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log "Generating throwaway configuration in $WORK"
DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
python3 - "$DATA" "$DOCKER_GID" "$PORT" "$IMAGE_PREFIX" "$IMAGE_TAG" <<'PY' | python3 "$ROOT/scripts/generate-env.py" "$ENV_FILE"
import json, sys
data, gid, port, prefix, tag = sys.argv[1:]
print(json.dumps({
    'DATA_ROOT': data, 'DOCKER_GID': gid, 'OPS_LOCAL_HOSTNAME': 'smoke',
    'BIND_ADDRESS': '127.0.0.1', 'PROXY_HTTP_PORT': port, 'TZ': 'UTC',
    'IMAGE_PREFIX': prefix, 'IMAGE_TAG': tag,
}))
PY

log "Preparing data directories"
# From a container, so the test needs no sudo on the host.
docker run --rm -v "$WORK:/work" -v "$ROOT/scripts/prepare-data-dirs.sh:/prepare.sh:ro" \
  "$HELPER_IMAGE" sh /prepare.sh /work/data

log "Validating Compose configuration"
compose config --quiet

log "Pulling images that are not present locally"
# --policy missing: an image that exists locally is never replaced, so a local
# build cannot be swapped for a same-named image from a registry.
# shellcheck disable=SC2086  # SERVICES is a deliberate word list
compose pull --quiet --policy missing --include-deps $SERVICES

log "Checking that application images run unprivileged"
for image in api frontend worker ai-worker security-worker; do
  ref="$IMAGE_PREFIX/$image:$IMAGE_TAG"
  docker image inspect "$ref" >/dev/null 2>&1 || docker pull -q "$ref" >/dev/null
  user="$(docker image inspect -f '{{.Config.User}}' "$ref")"
  [[ -n "$user" && "$user" != root && "$user" != 0 && "$user" != 0:0 ]] || fail "$ref runs as root"
  echo "  $image: user $user"
done

start_stack() {
  # shellcheck disable=SC2086  # SERVICES is a deliberate word list
  compose up -d --no-build --wait --wait-timeout 600 $SERVICES
}

log "Starting ${SERVICES:-the whole stack}"
start_stack
compose ps

check_stack() {
  log "Checking proxy, web interface and API"
  [[ "$(curl -fsS "$BASE/healthz")" == ok ]] || fail "proxy /healthz"
  curl -fsS "$BASE/" | grep -qi '<div id="root"' || fail "web interface did not return the application page"

  health="$(curl -fsS "$BASE/api/health")"
  echo "  /api/health: $health"
  python3 - "$health" "${SMOKE_VERSION:-}" <<'PY' || fail "/api/health"
import json, sys
health, version = json.loads(sys.argv[1]), sys.argv[2]
components = health['components']
assert components['database'] == 'ok', components
assert components['redis'] == 'ok', components
assert not version or health['version'] == version, (health['version'], version)
PY
}

login() {
  body="$(python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "$ADMIN_USER" "$ADMIN_PASSWORD")"
  token="$(curl -fsS -H 'Content-Type: application/json' -d "$body" "$BASE/api/auth/login" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" || fail "login"
  me="$(curl -fsS -H "Authorization: Bearer $token" "$BASE/api/auth/me")" || fail "/api/auth/me"
  python3 -c 'import json,sys; assert json.loads(sys.argv[1])["username"] == sys.argv[2]' "$me" "$ADMIN_USER" \
    || fail "authenticated user mismatch"
  echo "  logged in as $ADMIN_USER"
}

bootstrap_admin() {
  python3 -c 'import json,sys; print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}))' "$ADMIN_USER" "$ADMIN_PASSWORD" \
    | compose exec -T ops-api python -m app.management.bootstrap_admin
}

check_stack
log "Creating the administrator and logging in"
bootstrap_admin | grep -q 'Administrator created' || fail "administrator was not created"
login

log "Restarting the whole stack to check persistent storage"
compose down
start_stack
check_stack
bootstrap_admin | grep -q 'already exists' || fail "administrator did not survive a restart"
login

log "Smoke test passed"
