#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
VENV_ROOT="${OPS_CENTER_TEST_VENV:-$ROOT/.venv-tests}"
for component in backend worker security worker_ai; do
  python3 -m venv "$VENV_ROOT/$component"
  "$VENV_ROOT/$component/bin/pip" install --quiet -r "$component/requirements.txt" pytest pytest-asyncio
  PYTHONPATH="$ROOT:$ROOT/backend" "$VENV_ROOT/$component/bin/python" -m pytest "$component/tests" -q
done
"$VENV_ROOT/backend/bin/python" -m pytest tests -q
"$VENV_ROOT/worker/bin/ansible-playbook" --syntax-check -i deploy/inventory.example.ini deploy/install.yml -e ops_admin_username=test -e ops_admin_password=validation-only-password -e ops_release_archive=/tmp/unused.tar.gz
for playbook in ansible/playbooks/*.yml; do
  "$VENV_ROOT/worker/bin/ansible-playbook" --syntax-check -i localhost, "$playbook"
done
# Synthetic values exist only in this subprocess environment; nothing is saved.
POSTGRES_USER=test POSTGRES_DB=test POSTGRES_PASSWORD=validation-only REDIS_PASSWORD=validation-only API_SECRET_KEY=validation-only GRAFANA_ADMIN_PASSWORD=validation-only DOCKER_GID=1000 docker compose config --quiet
