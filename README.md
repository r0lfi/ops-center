# Ops Center
<img width="1888" height="864" alt="image" src="https://github.com/user-attachments/assets/9335bef7-e456-41c4-9c38-03739fdb353b" />




Ops Center is a self-hosted operations dashboard for Linux servers and Docker workloads. It combines inventory, monitoring, Ansible automation, patching, security findings and optional AI assistants in one web interface, including an interactive operations floor.

**Clone the repository and run the Ansible installer to build and start your own instance.** You do not need to build or publish container images beforehand: the installer builds the application images on your server and downloads the database and monitoring images automatically.

Each installation starts with an empty database and freshly generated credentials. Bring your own servers, SSH credentials and optional integration accounts.

> **Deployment status:** Image builds, Python tests, the frontend build and Ansible syntax checks have passed. The complete installer has not yet been tested on a fresh server. The included deployment targets one server; validate it in a test environment before production use. See [validation results](docs/validation.md).

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Remote installation and configuration](#remote-installation-and-configuration)
- [Container images](#container-images)
- [First configuration](#first-configuration)
- [Repository layout](#repository-layout)
- [Development and validation](#development-and-validation)
- [Contributing](#contributing)
- [License](#license)

## Features

- React/TypeScript frontend and FastAPI backend.
- Ansible execution worker, scheduler, security worker and AI worker.
- PostgreSQL and Redis, with persistent storage.
- Prometheus, Alertmanager, Grafana, Loki and Blackbox Exporter.
- Trivy server for vulnerability scanning; optional cAdvisor host metrics.
- Ansible installer, Dockerfiles, release checks and manually triggered GHCR image builds.

AI providers, cameras, VPN, Nextcloud Talk, SSH targets and traffic-map sources are optional and require your own configuration. The installer does not provision a Patroni/Sentinel HA cluster or external integrations.

## Requirements

Use a **dedicated Linux server** with the following prerequisites:

| Requirement | Details |
| --- | --- |
| Target operating system | AlmaLinux, Rocky Linux or RHEL 9/10 for automatic Docker installation |
| Architecture | x86-64 (`linux/amd64`) |
| Initial resource estimate | 4 CPU cores, 8 GB RAM and 30 GB free disk; allow more space for metrics retention and image caches |
| Installer machine | Git, Python 3.11 or newer with `venv`, and SSH for remote deployment |
| Target access | Sudo privileges; Python 3 available for Ansible |
| Network | Internet access to download packages, dependencies and container images |

The machine running Ansible is called the controller; the machine receiving the installation is the target. They can be the same server. If your distribution packages Python's `venv` support separately, install that package before running the installer.

Ansible is installed automatically in a project-local virtual environment. Docker Engine and Compose are installed on the target by default. For an existing Docker installation, see [configuration](#remote-installation-and-configuration).

## Quick start

### 1. Clone the repository on your server

Replace `YOUR-ACCOUNT` and the repository name below with the GitHub repository you want to install:

```bash
git clone https://github.com/YOUR-ACCOUNT/ops-center.git
cd ops-center
```

### 2. Run the installer

The default inventory installs on **the machine running this command**. For a different server, use the [remote installation instructions](#remote-installation-and-configuration).

```bash
bash scripts/install.sh --ask-become-pass
```

Enter the target's sudo password when requested, then choose an Ops Center administrator username and a password of at least 12 characters. Password input is hidden. If your target uses passwordless sudo, omit `--ask-become-pass`.

The installer:

1. Installs and starts Docker Engine and Compose from Docker's official RPM repository.
2. Copies the release to `/opt/ops-center` and creates persistent storage under `/var/lib/ops-center`.
3. Generates new PostgreSQL, Redis, API-signing and Grafana credentials in `/opt/ops-center/.env`, with file mode `0600`.
4. Builds the five application images and downloads the upstream service images.
5. Starts the services, runs database migrations and waits for health checks.
6. Creates your administrator account, storing its password as a hash in PostgreSQL.

You do not need to fill in `.env` or supply AI API keys for the initial installation. Conflicting container packages must be resolved manually. The playbook does not disable SELinux or open firewall ports.

### 3. Open the dashboard

By default the web interface binds to the server's loopback address. From your workstation:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

Open `http://localhost:8080` and sign in with the administrator account you created. Grafana is available at `/grafana/` with its separate `admin` account and generated password. Retrieve that password privately from the target's `.env` if needed; do not paste the file into issues or logs.

For shared access, configure an HTTPS reverse proxy on the target to `127.0.0.1:8080`. Caddy in this stack serves internal HTTP; it does not obtain public certificates automatically. API credentials must not travel over an untrusted plain HTTP connection.

## Remote installation and configuration

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

This Git repository contains **source code and Dockerfiles**, not prebuilt image archives. Building during installation is the default. Publishing images to a registry is optional and lets subsequent installations download them instead of building locally.

Upstream database and monitoring images are referenced separately by Compose.

### Build and publish your own images

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

### Install using published images

After publishing the five application images under your own namespace:

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

## Repository layout

| Path | Purpose |
| --- | --- |
| `frontend/` | React application and frontend Dockerfile |
| `backend/` | FastAPI application, database migrations and API Dockerfile |
| `worker/` | Ansible execution worker and scheduler |
| `worker_ai/` | AI agents, providers and tools |
| `security/` | Security scanning and Docker operations worker |
| `ansible/` | Automation playbooks executed against managed hosts |
| `deploy/` | Ansible installation playbook and example inventory |
| `monitoring/` | Monitoring configuration and Grafana dashboards |
| `proxy/` | Caddy reverse-proxy configuration |
| `scripts/` | Installation, image building, testing and packaging tools |
| `docs/` | Operations, integrations, security and validation documentation |
| `.github/workflows/` | Source validation and manually triggered image builds |

## Development and validation

Frontend development requires Node.js 22 and npm. Python test environments require Python 3.11 or newer; Compose validation requires Docker with the Compose plugin.

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

Run these commands from a Git checkout with reviewed changes staged or committed; packaging rejects unstaged changes to tracked files. Install Gitleaks separately before running the scanning commands. If you downloaded a source archive instead of cloning, extract it into a new directory, review its contents, then run `git init` and `git add .` before using the installer or packager.

Do not upload `.env`, database dumps, backups, SSH keys, private inventories, screenshots of live infrastructure or original deployment history. Enable GitHub secret scanning and push protection where available.

## Contributing

Open an issue for bugs or feature requests, or submit a pull request with a description of the change and relevant validation. For installation issues, include the operating system, Docker/Compose versions and redacted error output.

Keep examples generic and integrations configurable. Never include live credentials, private hostnames, inventories or runtime data in issues or pull requests. Report security concerns privately to the repository maintainer; see [security guidance](docs/security.md).

## License

Ops Center application code is distributed under the [MIT License](LICENSE). Third-party libraries, images and geographic data retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
