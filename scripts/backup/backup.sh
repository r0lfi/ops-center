#!/usr/bin/env bash
# Backs up everything needed to fully reconstruct this Ops Center deployment:
# the Postgres database (hosts, jobs, vulnerabilities, users, audit log, ...),
# Ansible run metadata, Grafana's runtime state, the SSH credential material
# under DATA_ROOT/secrets, and the .env file (without which the stack cannot
# be restarted with working credentials - see docs/backup-restore.md for the
# incident that made this an explicit requirement rather than an afterthought).
#
# Usage: scripts/backup/backup.sh
# Run from anywhere; it locates the repo root from this script's own path.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f .env ]]; then
    echo "error: .env not found in $REPO_ROOT - cannot determine DATA_ROOT/credentials" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

DATA_ROOT="${DATA_ROOT:-/data/ops-center}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$DATA_ROOT/backups/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"
chmod 700 "$DATA_ROOT/backups" "$BACKUP_DIR"

echo "[backup] writing to $BACKUP_DIR"

echo "[backup] dumping postgres..."
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
    | gzip > "$BACKUP_DIR/postgres.sql.gz"

echo "[backup] archiving grafana runtime state..."
# grafana's data dir is owned by the container's internal uid (472), not
# readable by this user - sudo is required to read it from the host side.
sudo tar czf "$BACKUP_DIR/grafana.tar.gz" -C "$DATA_ROOT" grafana
sudo chown "$(id -u):$(id -g)" "$BACKUP_DIR/grafana.tar.gz"

echo "[backup] archiving ansible run metadata..."
if [[ -n "$(sudo ls -A "$DATA_ROOT/ansible" 2>/dev/null)" ]]; then
    sudo tar czf "$BACKUP_DIR/ansible.tar.gz" -C "$DATA_ROOT" ansible
    sudo chown "$(id -u):$(id -g)" "$BACKUP_DIR/ansible.tar.gz"
fi

echo "[backup] archiving SSH credential material..."
if [[ -n "$(sudo ls -A "$DATA_ROOT/secrets" 2>/dev/null)" ]]; then
    sudo tar czf "$BACKUP_DIR/secrets.tar.gz" -C "$DATA_ROOT" secrets
    sudo chown "$(id -u):$(id -g)" "$BACKUP_DIR/secrets.tar.gz"
fi

echo "[backup] archiving deployment config (.env, compose.yml)..."
tar czf "$BACKUP_DIR/config.tar.gz" -C "$REPO_ROOT" .env compose.yml

cat > "$BACKUP_DIR/MANIFEST.txt" <<EOF
Ops Center backup
Created (UTC): $TIMESTAMP
Host: $(hostname)
Repo root: $REPO_ROOT
Data root: $DATA_ROOT
Contents:
  postgres.sql.gz  - full pg_dump of $POSTGRES_DB
  grafana.tar.gz    - Grafana runtime state (dashboards use provisioning-as-code, this is user prefs/session state)
  ansible.tar.gz    - Ansible run metadata (present only if non-empty)
  secrets.tar.gz    - SSH credential material from DATA_ROOT/secrets (present only if non-empty)
  config.tar.gz     - .env and compose.yml
EOF

chmod 600 "$BACKUP_DIR"/*

echo "[backup] done: $BACKUP_DIR (contains secrets; keep private)"
