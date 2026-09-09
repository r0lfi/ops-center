#!/bin/sh
set -eu

echo "[entrypoint] running database migrations..."
alembic upgrade head

echo "[entrypoint] starting: $*"
exec "$@"
