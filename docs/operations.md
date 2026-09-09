# Operations

Run Compose commands from `/opt/ops-center` with privileges to read `.env` and access Docker. `sudo docker compose ps` shows service status. Inspect individual service logs carefully: application logs can contain infrastructure details and should not be posted publicly without review.

Back up before updates. `sudo bash scripts/backup/backup.sh` creates a private backup under the configured data root, including the database, secrets and deployment configuration. It does not prune older backups. Store an encrypted copy outside the host and test restoration. This helper is not a transactionally consistent snapshot of every monitoring service: stop workloads or use coordinated storage snapshots if that guarantee is required. Metrics/log history and Docker-managed stack volumes need separate backup policies.

`scripts/restore/restore.sh` is destructive and requires an interactive confirmation. Test it against a separate recovery host. Existing database contents and selected runtime files are replaced. Never execute it on the only copy of data you need to preserve.

The administrator bootstrap preserves existing users. To create another administrator, use `sudo docker compose exec ops-api python -m app.management.create_admin` and follow its interactive prompts.

To update images, change `IMAGE_PREFIX`/`IMAGE_TAG` in the private `.env`, then intentionally pull/recreate the stack during a maintenance window. API startup runs Alembic migrations. Rollback may require restoring a compatible database backup; changing an image tag alone cannot undo schema changes.

Enable optional host metrics with `sudo docker compose --profile host-metrics up -d`. cAdvisor requires additional host access and `/dev/kmsg`; validate these permissions on your target. Without this profile, its Prometheus scrape target may be down while core services remain healthy.

Docker repository and package choices in the installer follow the [official Docker RHEL installation documentation](https://docs.docker.com/engine/install/rhel/). Package versions and platform compatibility should be reviewed when maintaining the installer.
