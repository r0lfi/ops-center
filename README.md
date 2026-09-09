# Ops Center

Ops Center is a self-hosted operations dashboard for Linux servers and Docker workloads. It combines inventory, monitoring, Ansible automation, patching, security findings and optional AI assistants in one web interface, including an interactive operations floor.

This repository contains application source and a **single-server installation**. It starts with an empty database and freshly generated credentials. No infrastructure inventory, provider keys or deployment data is included.

## What is included

- React/TypeScript frontend and FastAPI backend.
- Ansible execution worker, scheduler, security worker and AI worker.
- PostgreSQL and Redis, with persistent storage.
- Prometheus, Alertmanager, Grafana, Loki and Blackbox Exporter.
- Trivy server for vulnerability scanning; optional cAdvisor host metrics.
- Ansible installer, Dockerfiles, release checks and manually triggered GHCR image builds.

AI providers, cameras, VPN, Nextcloud Talk, SSH targets and traffic-map sources are optional and require your own configuration. The installer does not provision a Patroni/Sentinel HA cluster or external integrations.

## Install

Use a **dedicated Linux server**. Automatic Docker installation targets AlmaLinux, Rocky Linux and RHEL 9/10 on x86-64. Allow approximately 4 CPU cores, 8 GB RAM and 30 GB free disk as an initial planning estimate; metrics retention and image caches need additional space. Internet access is required to obtain dependencies and images.

The controller needs Git, Python 3.11 or newer with `venv`, SSH and sudo access to the target. For a local installation, the controller and target are the same machine. On distributions that split Python's venv support into a separate package, install that package first.

```bash
git clone <your-repository-url> ops-center
cd ops-center
bash scripts/install.sh --ask-become-pass
```

The script installs Ansible in a project-local virtual environment and asks for an administrator username and password. The password prompt is hidden. Generated PostgreSQL, Redis, API-signing and Grafana credentials are stored in `/opt/ops-center/.env` with mode `0600`; administrator passwords are stored as hashes in PostgreSQL.

The playbook configures Docker's official RPM repository, installs and starts Docker, extracts the release to `/opt/ops-center`, creates persistent directories under `/var/lib/ops-center`, builds five application images, starts the stack, waits for health checks and creates the administrator. **Run it only on the intended target.** It does not disable SELinux or open firewall ports. Conflicting container packages must be resolved manually.

By default the web interface binds to the server's loopback address. From your workstation:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

Open `http://localhost:8080` and sign in with the administrator account you created. Grafana is available at `/grafana/` with its separate `admin` account and generated password. Retrieve that password privately from the target's `.env` if needed; do not paste the file into issues or logs.

For shared access, configure an HTTPS reverse proxy on the target to `127.0.0.1:8080`. Caddy in this stack serves internal HTTP; it does not obtain public certificates automatically. API credentials must not travel over an untrusted plain HTTP connection.

### Remote installation and configuration

```bash
cp deploy/inventory.example.ini deploy/inventory.ini
# Edit inventory.ini: remove localhost and enter your SSH target.
bash scripts/install.sh -i deploy/inventory.ini --ask-become-pass \
  -e ops_timezone=UTC -e ops_http_port=8080
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ops_install_dir` | `/opt/ops-center` | Installed source and Compose files |
| `ops_data_root` | `/var/lib/ops-center` | Persistent data, outside the repository |
| `ops_timezone` | `UTC` | Scheduled patching timezone |
| `ops_bind_address` | `127.0.0.1` | Web listen address |
| `ops_http_port` | `8080` | Web port |
| `ops_install_docker` | `true` | Install Docker CE on supported RPM systems |
| `ops_build_images` | `true` | Build locally; set false to pull your published images |
| `ops_image_prefix` | `ops-center` | Registry/namespace shared by the five images |
| `ops_image_tag` | `local` | Application image tag |

With an existing Docker Engine and Compose v2, pass `-e ops_install_docker=false`. Git and Python must already be installed on that target. The installer requires a local Docker socket and Compose with `up --wait`; rootless Podman is not a supported installation target.

For unattended installation, provide `ops_admin_username` and `ops_admin_password` through an **Ansible Vault-encrypted variable file**, using `-e @/secure/path/bootstrap.yml --ask-vault-pass`. Do not place passwords in command-line `-e` strings or commit private inventory/variable files.

Re-running preserves `.env` and existing administrator credentials. New installer variables do not overwrite an existing `.env`; edit it explicitly for configuration changes. A rerun can replace bundled source/playbooks, recreate application containers and run database migrations: back up first and schedule upgrades appropriately.

## Container images

Five custom images are built from this source:

| Image suffix | Component |
| --- | --- |
| `api` | FastAPI API and database migrations |
| `frontend` | Compiled web interface served by Nginx |
| `worker` | Ansible execution and scheduler (shared image) |
| `ai-worker` | Optional AI agent execution |
| `security-worker` | Docker operations and security scans |

Upstream database and monitoring images are referenced separately by Compose.

Build under your own registry namespace:

```bash
export IMAGE_PREFIX=ghcr.io/your-account/ops-center
export IMAGE_TAG=0.1.0
bash scripts/images.sh build

# Only when you intentionally want to publish:
docker login ghcr.io
bash scripts/images.sh push
```

For local Podman builds, set `CONTAINER_ENGINE=podman`. This builds images only; the deployment playbook uses Docker Engine.

Alternatively, run GitHub Actions → **Build or publish images**. Its `publish` option defaults to false. When enabled, it publishes `ghcr.io/<owner>/<repository>/<suffix>:<tag>` using GitHub's short-lived `GITHUB_TOKEN`, without adding registry credentials to this repository. Make the resulting packages public if anonymous installations should be able to pull them. Only `linux/amd64` is currently configured.

To install already-published images:

```bash
bash scripts/install.sh --ask-become-pass \
  -e ops_build_images=false \
  -e ops_image_prefix=ghcr.io/your-account/ops-center \
  -e ops_image_tag=0.1.0
```

Authenticate Docker on the target beforehand if your packages are private. No images are published by the installation script.

## First configuration

Add SSH credentials and hosts through the application workflow. Private key/password files belong under the runtime `secrets` directory, never under version control. The containers read secrets as UID 1000; use restricted permissions and the matching ownership. `scripts/credentials/generate-ssh-key.sh` can generate a fresh key; authorize its public key only on hosts you intend to manage.

Set `OPS_LOCAL_HOSTNAME` to the hostname used for this Docker host in inventory; the installer uses the target's hostname. Local security jobs are routed using this value.

Add your own AI provider credentials through the AI settings screen. The application can run without any AI provider configured. See [optional integrations](docs/integrations.md), [security](docs/security.md) and [operations](docs/operations.md) for runtime configuration and boundaries.

## Development and validation

```bash
cd frontend
npm ci
npm run build
cd ..
bash scripts/test/run-tests.sh
```

Python tests use separate virtual environments for the components' different pinned dependencies. The test runner also checks Ansible syntax and Compose without contacting a running deployment. See [validation results](docs/validation.md) for what has actually been exercised for this release.

Before creating an archive or publishing source:

```bash
python3 scripts/check-release.py
gitleaks dir . --redact
gitleaks git . --redact
python3 scripts/package.py /tmp/ops-center-release.tar.gz
```

The packager includes only indexed Git files, rejects private/runtime paths, checks staged and working copies, and excludes Git history. `.gitignore` and `.dockerignore` provide additional protection. Review source and staged changes before every release: automated scanning cannot prove that arbitrary new content contains no secrets.

Do not upload `.env`, database dumps, backups, SSH keys, private inventories, screenshots of live infrastructure or original deployment history. Enable GitHub secret scanning and push protection where available.

## License

Ops Center application code is distributed under the [MIT License](LICENSE). Third-party libraries, images and geographic data retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
