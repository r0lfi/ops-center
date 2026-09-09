#!/usr/bin/env bash
# Generates a new ed25519 SSH keypair for use as an Ops Center credential.
# Runs entirely on the host filesystem - the private key never touches
# ops-api (its secrets mount is read-only, deliberately: see
# docs/security.md and docs/architecture.md) and never goes over HTTP in
# either direction. Only the public key (safe, non-secret) is meant to be
# pasted into the Ops Center UI afterwards.
#
# Usage: scripts/credentials/generate-ssh-key.sh <name> [ssh_user]
#   e.g. scripts/credentials/generate-ssh-key.sh example-dns-03 example

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <name> [ssh_user]" >&2
    exit 1
fi
NAME="$1"
SSH_USER="${2:-}"

if [[ ! -f .env ]]; then
    echo "error: .env not found in $REPO_ROOT" >&2
    exit 1
fi
DATA_ROOT="$(grep '^DATA_ROOT=' .env | cut -d= -f2-)"
DATA_ROOT="${DATA_ROOT:-/data/ops-center}"

CRED_DIR="$DATA_ROOT/secrets/credentials"
sudo mkdir -p "$CRED_DIR"

KEY_PATH="$CRED_DIR/$NAME"
if [[ -e "$KEY_PATH" ]]; then
    echo "error: $KEY_PATH already exists - pick a different name or remove it first" >&2
    exit 1
fi

sudo ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "ops-center:${NAME}" -q
sudo chmod 600 "$KEY_PATH"
sudo chmod 644 "$KEY_PATH.pub"
sudo chown "$(id -u):$(id -g)" "$KEY_PATH" "$KEY_PATH.pub"

echo "Private key written to: $KEY_PATH (never leaves this host)"
echo
echo "Public key (paste into Ops Center -> Settings -> Credentials -> Add credential):"
echo
sudo cat "$KEY_PATH.pub"
echo
echo "Also add that public key to the target server's ~/${SSH_USER:-<user>}/.ssh/authorized_keys."
echo
echo "In the Add credential form, use:"
echo "  credential_type: ssh_key"
echo "  secret_filename: $NAME"
[[ -n "$SSH_USER" ]] && echo "  ssh_user: $SSH_USER"
