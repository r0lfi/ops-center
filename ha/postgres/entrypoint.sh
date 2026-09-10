#!/bin/sh
set -eu
# Docker mounts bootstrap configuration read-only. The private runtime copy
# and database directory are owned by the unprivileged database process.
umask 077
mkdir -p /var/lib/postgresql/data /var/run/postgresql
chown postgres:postgres /var/lib/postgresql/data /var/run/postgresql
chmod 700 /var/lib/postgresql/data
cp /etc/patroni-bootstrap.yml /tmp/patroni.yml
chown postgres:postgres /tmp/patroni.yml
exec gosu postgres /opt/patroni/bin/patroni /tmp/patroni.yml
