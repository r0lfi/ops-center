#!/bin/sh
# Create Ops Center's persistent data directories with the owners each
# container runs as. Needed only when running Compose without the installer;
# deploy/install.yml does the same. Safe to re-run: existing data is kept.
#
#   sudo sh scripts/prepare-data-dirs.sh /var/lib/ops-center
#
# Keep this list in step with "Create runtime data directories" in
# deploy/install.yml.
set -eu

DATA_ROOT="${1:?Usage: prepare-data-dirs.sh DATA_ROOT}"
case "$DATA_ROOT" in
  /|/etc|/usr|/var|/opt|/home) echo "Refusing to use $DATA_ROOT as the data root." >&2; exit 2 ;;
  /*) ;;
  *) echo 'DATA_ROOT must be an absolute path.' >&2; exit 2 ;;
esac

mkdir -p "$DATA_ROOT"
chmod 0711 "$DATA_ROOT"
while read -r path uid mode; do
  mkdir -p "$DATA_ROOT/$path"
  chown "$uid:$uid" "$DATA_ROOT/$path"
  chmod "$mode" "$DATA_ROOT/$path"
done <<EOF
secrets 1000 0750
secrets/ai-providers 1000 0700
secrets/integrations 1000 0700
prometheus 65534 0755
prometheus/file_sd 1000 0755
prometheus/data 65534 0750
alertmanager 65534 0750
grafana 472 0750
loki 10001 0750
postgres 999 0700
redis 999 0750
trivy 0 0750
geoip 1000 0755
docker-stacks 1000 0750
EOF

# Empty monitoring discovery; an existing inventory is never replaced.
targets="$DATA_ROOT/prometheus/file_sd/node_exporters.json"
if [ ! -e "$targets" ]; then
  echo '[]' > "$targets"
  chown 1000:1000 "$targets"
  chmod 0644 "$targets"
fi
echo "Data directories ready under $DATA_ROOT"
