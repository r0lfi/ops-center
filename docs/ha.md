# HA / cluster deployment

The public distribution includes a generator and Ansible preparation playbook for
**two application/database hosts and one independent witness**. The ordinary
`deploy/install.yml` remains the single-server installer.

The generator creates fresh credentials and configuration from your own inventory.
It does not copy an existing installation, databases, keys, host inventory or Git
history. This is a reference HA deployment, not a zero-downtime guarantee.

## Topology

| Component | Application node 1 | Application node 2 | Witness |
| --- | --- | --- | --- |
| API, frontend, ordinary/security/AI workers | Yes | Yes | No |
| Scheduler | RedBeat, shared Redis lock | RedBeat, same lock | No |
| PostgreSQL 17 / Patroni | Primary or replica | Primary or replica | No |
| etcd | Member | Member | Third voting member |
| Redis | Primary or replica | Primary or replica | No |
| Sentinel | Voter | Voter | Third voter (quorum 2) |
| PostgreSQL HAProxy | Local database endpoint | Local database endpoint | No |
| Monitoring | Local data | Separate local data | No |

Each application's `pg-router:5432` checks Patroni `/primary` and routes to the
current primary. Redis clients and Celery discover the Redis primary through
Sentinel. A third host provides quorum; place it in an independent failure domain.
The witness holds no PostgreSQL or application signing credentials.

## Requirements and network boundary

Use three **fresh, dedicated Linux hosts** with Docker Engine, Compose v2 and
Python 3 already installed. The controller needs Ansible and PyYAML (available in
the installer's virtual environment). Application nodes need capacity for the
full application stack as well as a PostgreSQL and Redis replica. Use the same
source revision and container image versions on both application nodes.

This reference uses host networking for the cross-host data plane. **Before
starting containers, enforce an isolated trusted cluster network and source-scoped
firewall rules.** The playbook does not change your firewall, routes or TLS setup.

| TCP port | Allowed callers | Purpose |
| --- | --- | --- |
| 2379 | The three cluster hosts only | etcd clients |
| 2380 | The three cluster hosts only | etcd peers |
| 5432 | The two application hosts only | PostgreSQL / replication |
| 8008 | The two application hosts and designated administrators | Patroni checks/admin |
| 6379 | The three cluster hosts only | Redis replication / clients |
| 26379 | The three cluster hosts only | Sentinel discovery / voting |
| 8080 | Your trusted ingress or SSH tunnel | Web application |

Listeners bind to the explicitly configured host addresses. Redis data access and
Patroni administrative actions use generated passwords. **etcd and Sentinel have
no client authentication in this reference, and cross-host traffic is not TLS
encrypted.** Do not expose these ports to clients or untrusted networks. Deploy
mTLS/access controls or an authenticated encrypted overlay before using an
untrusted transport. PostgreSQL's HBA permits the two application host addresses
only, with SCRAM authentication. Docker's outbound traffic must be masqueraded to
those addresses; routed container networks need explicitly reviewed HBA additions.

## 1. Generate private configuration on the controller

Create an inventory **outside this checkout**. The addresses below are RFC 5737
documentation addresses: replace them with your own reachable IPv4 addresses.
The first two entries are application/database hosts; the last is the witness.
Node names must match Ansible inventory aliases and the actual application
hostnames used for local Docker routing (`OPS_LOCAL_HOSTNAME`).

```json
{
  "nodes": [
    {"name": "app-node-1", "ip": "192.0.2.11"},
    {"name": "app-node-2", "ip": "192.0.2.12"},
    {"name": "quorum-node", "ip": "192.0.2.13"}
  ],
  "install_dir": "/opt/ops-center",
  "data_root": "/var/lib/ops-center"
}
```

Save as `../ha-inventory.json`, then from the public checkout:

```bash
python3 -m venv .venv-installer
.venv-installer/bin/pip install 'ansible-core==2.18.19'
.venv-installer/bin/python scripts/ha/generate.py ../ha-inventory.json ../ha-runtime
python3 scripts/package.py /tmp/ops-center-public.tar.gz
```

Use your Ansible environment's Python if its directory has a different name.
All generated files are mode 0600; directories are 0700. Keep the **entire output**
private, including YAML and Redis config files. It includes shared passwords and
host topology. The generator refuses existing output and output inside the repo;
it never silently rotates an installed cluster's secrets. Back up this bundle
securely. Do not regenerate it for an upgrade.

## 2. Prepare the three fresh hosts

Create a private Ansible inventory, e.g. `../ha-hosts.ini`:

```ini
[ops_ha_apps]
app-node-1 ansible_host=192.0.2.11
app-node-2 ansible_host=192.0.2.12

[ops_ha_witness]
quorum-node ansible_host=192.0.2.13

[ops_ha:children]
ops_ha_apps
ops_ha_witness
```

```bash
.venv-installer/bin/ansible-playbook -i ../ha-hosts.ini deploy/ha.yml --ask-become-pass \
  -e ops_release_archive=/tmp/ops-center-public.tar.gz \
  -e ops_ha_bundle="$(realpath ../ha-runtime)"
```

If you changed `install_dir` or `data_root` in the JSON, pass the matching
`ops_install_dir` and `ops_data_root` variables. The playbook extracts reviewed
source, installs only each host's generated configuration in
`/opt/ops-center/ha-runtime`, creates application storage and detects `DOCKER_GID`.
It deliberately refuses existing HA configuration. It **does not start services**.
Never use it to overwrite an existing standalone installation or database.

## 3. Start the data plane

On **all three hosts**, in `/opt/ops-center/ha-runtime`:

```bash
sudo docker compose -f compose.ha.yml up -d --build
```

This downloads pinned upstream images and builds `ha/postgres/Dockerfile` on the
two database nodes. For offline installation, build/pull on an equivalent connected
host and transfer images using `docker image save` / `docker image load`; run
`up -d --no-build --pull never` after loading them. The generated configuration
contains secrets; do not include it in a public image or release archive.

Inspect both Patroni nodes (replace the example addresses):

```bash
curl --fail http://192.0.2.11:8008/patroni
curl --fail http://192.0.2.12:8008/patroni
```

Wait for one primary and one streaming replica and all three etcd members before
starting applications. On the **current primary host only**, create the application
database once, using the local socket inside the database container:

```bash
sudo docker compose -f compose.ha.yml exec patroni \
  gosu postgres createdb -U opscenter opscenter
```

`database already exists` on a rerun does not mean it should be dropped.
PostgreSQL volumes are named Docker volumes (`ops-center-ha_postgres-data`),
separate from standalone `DATA_ROOT/postgres`. Never point Patroni at an existing
standalone data directory. The generated Redis replica starts with `replicaof`
already configured; there is no interval with two independently bootstrapped
primaries. Redis and Sentinel copy their seed config only on first boot and keep
rewritten topology in named volumes thereafter. Do not delete those volumes.

## 4. Start the application nodes in order

On application node 1, in the same runtime directory:

```bash
sudo docker compose -f compose.app.yml build
sudo docker compose -f compose.app.yml up -d --no-build --wait --wait-timeout 600
sudo -v
python3 -c 'import getpass,json; print(json.dumps({"username": "admin", "password": getpass.getpass("Admin password: ")}))' | \
  sudo -n docker compose -f compose.app.yml exec -T ops-api python -m app.management.bootstrap_admin
```

The administrator bootstrap reads JSON from stdin. The command above prompts
for a password without echoing it. For unattended setup, use an approved secret
manager to supply the JSON. Do not put the password in shell arguments or history.

After the first API has completed Alembic migrations and is healthy, build/start
node 2 with the first two commands. Do not run competing schema migrations on
initial startup or upgrades. Both nodes share application signing credentials,
PostgreSQL data, Redis queues and the RedBeat scheduler lock. Container control
uses each node's `OPS_LOCAL_HOSTNAME` and its node-specific security queue.

The web listener defaults to localhost:8080 on each host. Test through SSH tunnels.
For shared access, configure the appropriate `BIND_ADDRESS` in **both private**
`.env` files and use your redundant HTTPS ingress/load balancer to health-check
both application nodes. The generator does not provision a floating IP,
keepalived or a redundant external load balancer. A single load balancer remains
a single point of failure.

## 5. Verify failover in a disposable environment

1. Log in as admin and open **Cluster**. Confirm two Patroni members, one primary,
   two Redis nodes, three reachable Sentinels, and agreement about the Redis primary.
2. Use **Trigger switchover** and confirm. Verify the PostgreSQL primary changes,
   `pg-router` follows it, and both application URLs still read/write the same data.
   A timeout is ambiguous: inspect the actual state before retrying.
3. In a maintenance window on a disposable test cluster, stop only the current
   Redis-primary container. Verify Sentinel promotes the replica and API/Celery
   reconnect. Restart the stopped container and verify it becomes a replica.
4. Test application-node loss through your external ingress. Verify surviving
   workers consume jobs and that node-specific Docker jobs do not run elsewhere.
5. Restore all members and verify replication, quorum, queue consumption and
   database consistency. Simulate witness loss separately; loss of two etcd
   members removes quorum and must not permit two writable PostgreSQL primaries.

Do not execute fault-injection tests on a live environment without an approved
maintenance window. Replication is asynchronous by default: recent writes/queue
messages can be lost during abrupt failover. Celery redelivery can repeat work;
HA does not provide exactly-once execution. Test the behavior of your own jobs.

## Files, monitoring, backups and upgrades

HA of PostgreSQL/Redis does not replicate every filesystem. Securely synchronize
provider-key files, SSH credentials, integration secrets and editable playbooks
between application nodes, preserving ownership and mode. Coordinate writes to
avoid stale keys or conflicting playbooks. Until this is provided, actions that
need a file available on only one node can fail on the other node.

Prometheus, Loki, Grafana and their volumes remain independent per node in this
reference. Use dedicated HA monitoring/log storage if a single consistent history
is required. Application jobs and user records are shared through PostgreSQL.

The standalone backup script targets the standalone PostgreSQL container; it is
**not the HA backup procedure**. Take logical backups from the active Patroni
primary with `pg_dump`, back up required local files and private configuration,
and test restoration into a separate fresh cluster. A replica is not a backup.
Migration from standalone requires a planned, application-consistent logical
backup/restore, credentials alignment and a controlled cutover; it is not automated.

For upgrades, preserve generated configuration and named volumes. Review and merge
changes to generated Compose files, distribute the same reviewed source/images to
both nodes, run migrations once, then roll application nodes individually while
checking compatibility. Never rerun the fresh-cluster generator over an existing
bundle, use `down -v`, or restore over a live database as an upgrade shortcut.

Upstream behavior references: [Patroni REST API](https://patroni.readthedocs.io/en/latest/rest_api.html)
and [Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/).
