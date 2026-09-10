#!/usr/bin/env bash
# No login or push is performed by the build command.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ACTION="${1:-build}"
ENGINE="${CONTAINER_ENGINE:-docker}"
PREFIX="${IMAGE_PREFIX:-ops-center}"
TAG="${IMAGE_TAG:-0.1.0}"
python3 scripts/check-release.py
components=(api frontend worker ai-worker security-worker postgres-ha)
contexts=(backend frontend . . . ha/postgres)
dockerfiles=(backend/Dockerfile frontend/Dockerfile worker/Dockerfile worker_ai/Dockerfile security/Dockerfile ha/postgres/Dockerfile)
case "$ACTION" in
  build)
    for i in "${!components[@]}"; do
      "$ENGINE" build --pull -f "${dockerfiles[$i]}" -t "$PREFIX/${components[$i]}:$TAG" "${contexts[$i]}"
    done
    ;;
  push)
    if [[ "$PREFIX" == ops-center ]]; then
      echo 'Set IMAGE_PREFIX to your registry namespace before pushing.' >&2
      exit 1
    fi
    for component in "${components[@]}"; do "$ENGINE" push "$PREFIX/$component:$TAG"; done
    ;;
  *) echo 'Usage: scripts/images.sh build|push' >&2; exit 2 ;;
esac
