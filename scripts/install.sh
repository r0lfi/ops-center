#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-installer"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet 'ansible-core==2.18.19'
ARCHIVE="$(mktemp /tmp/ops-center-release.XXXXXX.tar.gz)"
trap 'rm -f "$ARCHIVE"' EXIT
python3 "$ROOT/scripts/package.py" "$ARCHIVE"
cd "$ROOT"
exec_args=("$@")
has_inventory=false
for argument in "$@"; do
  case "$argument" in -i*|--inventory*) has_inventory=true ;; esac
done
if [[ "$has_inventory" == false ]]; then
  exec_args=(-i deploy/inventory.example.ini "${exec_args[@]}")
fi
"$VENV/bin/ansible-playbook" deploy/install.yml "${exec_args[@]}" -e "ops_release_archive=$ARCHIVE"
