#!/usr/bin/env bash
# Restores an Ops Center backup produced by scripts/backup/backup.sh.
# This is destructive: it overwrites the live Postgres database and the
# runtime state under DATA_ROOT. It asks for confirmation before doing so.
#
# Usage: scripts/restore/restore.sh <backup-timestamp>
#   e.g. scripts/restore/restore.sh 20260827T120000Z
# List available backups with: ls "$DATA_ROOT/backups"

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <backup-timestamp>" >&2
    exit 1
fi

if [[ ! -f .env ]]; then
    echo "error: .env not found in $REPO_ROOT" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

DATA_ROOT="${DATA_ROOT:-/data/ops-center}"
BACKUP_DIR="$DATA_ROOT/backups/$1"

if [[ ! -d "$BACKUP_DIR" ]]; then
    echo "error: no backup at $BACKUP_DIR" >&2
    exit 1
fi

echo "About to restore from: $BACKUP_DIR"
cat "$BACKUP_DIR/MANIFEST.txt" 2>/dev/null || true
echo
echo "This will STOP the app-tier containers, REPLACE the postgres database,"
echo "and overwrite grafana/ansible/secrets state under $DATA_ROOT."
read -r -p "Type 'restore' to continue: " CONFIRM
if [[ "$CONFIRM" != "restore" ]]; then
    echo "aborted"
    exit 1
fi

echo "[restore] stopping app-tier containers..."
docker compose stop ops-api ops-worker ops-scheduler ops-ai-worker security-worker ops-frontend

if [[ -f "$BACKUP_DIR/postgres.sql.gz" ]]; then
    echo "[restore] restoring postgres (drop + recreate database)..."
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
        -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";" \
        -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"
    gunzip -c "$BACKUP_DIR/postgres.sql.gz" \
        | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
else
    echo "[restore] warning: no postgres.sql.gz in backup, skipping database restore" >&2
fi

if [[ -f "$BACKUP_DIR/grafana.tar.gz" ]]; then
    echo "[restore] restoring grafana state..."
    sudo tar xzf "$BACKUP_DIR/grafana.tar.gz" -C "$DATA_ROOT"
fi

if [[ -f "$BACKUP_DIR/ansible.tar.gz" ]]; then
    echo "[restore] restoring ansible metadata..."
    sudo tar xzf "$BACKUP_DIR/ansible.tar.gz" -C "$DATA_ROOT"
fi

if [[ -f "$BACKUP_DIR/secrets.tar.gz" ]]; then
    echo "[restore] restoring SSH credential material..."
    sudo tar xzf "$BACKUP_DIR/secrets.tar.gz" -C "$DATA_ROOT"
fi

echo "[restore] NOTE: config.tar.gz (.env, compose.yml) was NOT auto-applied."
echo "[restore] Review $BACKUP_DIR/config.tar.gz manually before overwriting the live .env."

echo "[restore] bringing app-tier containers back up..."
docker compose up -d --force-recreate ops-api ops-worker ops-scheduler ops-ai-worker security-worker ops-frontend

echo "[restore] done."
