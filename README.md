# 🚀 Ops Center

### Self-hosted AI-assisted operations platform for Linux, containers, automation, monitoring and security.

<p align="center">
  <strong>Linux • Docker • Ansible • Monitoring • Security • Automation • AI Agents</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Self--Hosted-Yes-success" alt="Self Hosted">
  <img src="https://img.shields.io/badge/Linux-RHEL%20%7C%20AlmaLinux%20%7C%20Rocky-orange" alt="Linux">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Ansible-Automation-EE0000?logo=ansible&logoColor=white" alt="Ansible">
  <img src="https://img.shields.io/badge/AI-Agents-8A2BE2" alt="AI Agents">
</p>

---

## What is Ops Center?

**Ops Center** is an open-source, self-hosted operations platform built to bring infrastructure management into one interface.

Instead of constantly switching between monitoring dashboards, Ansible, vulnerability scanners, Docker tools, SSH sessions and AI assistants, Ops Center brings them together into a single operations environment.

It is designed primarily for **Linux administrators, DevOps engineers, homelab users and infrastructure teams**.

Ops Center combines:

- 🐧 Linux server management
- 🐳 Docker workload management
- ⚙️ Ansible automation
- 📊 Monitoring and observability
- 🔐 Vulnerability and security scanning
- 🔄 Patching and scheduled operations
- 🤖 AI-assisted infrastructure operations
- 🛰️ Interactive **2D and 3D Operations Floor**
- 💬 Agent chat and task interaction
- 📡 Optional integrations such as Nextcloud Talk and external AI providers

> **Project status:** Ops Center is under active development. Test it in a lab environment before using it against production infrastructure.

---

## 🤖 Operations Floor

One of the core ideas behind Ops Center is to make infrastructure automation and AI agents **visible**.

The Operations Floor provides a live 2D/3D representation of specialized agents working across your environment.

| Agent | Responsibility |
| --- | --- |
| 🐧 **Linux Ops** | Linux server health and administration |
| 🐳 **Containers** | Docker and container workloads |
| 📊 **Monitoring** | Metrics, alerts and infrastructure health |
| 🔐 **Security** | Vulnerabilities and security findings |
| 🔄 **Patching** | Patch management and scheduling |
| ⚙️ **Automation** | Infrastructure automation |
| 🌐 **Network** | Network-related operations |
| 💬 **Chat** | User interaction |
| 🧠 **Coordinator** | Routes requests to specialized agents |

Agents can display their current state, tasks and recent activity.

The goal is not simply to create another dashboard. The goal is to build a **self-hosted operations workspace where humans, automation and AI agents can work together**.

---

## ✨ Features

### Infrastructure

- Linux server inventory
- RHEL / AlmaLinux / Rocky Linux focused deployment
- SSH-based management
- Host health information
- Docker workload management
- Infrastructure task execution

### Automation

- Ansible execution worker
- Scheduler
- Infrastructure playbooks
- Remote task execution
- Scheduled operations

### Monitoring

- Prometheus
- Grafana
- Alertmanager
- Loki
- Blackbox Exporter
- Optional cAdvisor metrics

### Security

- Trivy vulnerability scanning
- Security worker
- Container security operations
- Infrastructure findings
- Vulnerability visibility

### AI

AI functionality is optional — **Ops Center can operate without an AI provider configured**.

The architecture includes a dedicated AI worker and provider integrations while keeping infrastructure execution separated into specialized workers.

Bring your own provider credentials.

---

## 🏗️ Architecture

```text
                         ┌──────────────────────┐
                         │      Web Browser     │
                         └──────────┬───────────┘
                                    │
                              ┌─────▼─────┐
                              │   Caddy   │
                              │   Proxy   │
                              └─────┬─────┘
                                    │
                 ┌──────────────────┴──────────────────┐
                 │                                     │
          ┌──────▼──────┐                       ┌──────▼──────┐
          │    React    │                       │   FastAPI   │
          │   Frontend  │                       │     API     │
          └─────────────┘                       └──────┬──────┘
                                                     │
              ┌──────────────────────────────────────┼─────────────────────┐
              │                  │                   │                     │
       ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐      ┌──────▼──────┐
       │   Ansible   │    │  AI Worker  │    │  Security   │      │  Scheduler  │
       │   Worker    │    │             │    │   Worker    │      │             │
       └─────────────┘    └─────────────┘    └─────────────┘      └─────────────┘
              │
              ▼
        Managed Linux Hosts

         Prometheus ── Grafana ── Loki ── Alertmanager ── Trivy

          PostgreSQL                                  Redis
```

---

## 🧰 Technology Stack

**Frontend:** React, TypeScript  
**Backend:** FastAPI, Python  
**Automation:** Ansible  
**Containers:** Docker, Docker Compose  
**Data:** PostgreSQL, Redis  
**Monitoring:** Prometheus, Grafana, Loki, Alertmanager, Blackbox Exporter  
**Security:** Trivy

---

## 🚀 Quick Start

### Requirements

Use a dedicated Linux server with the following prerequisites:

| Requirement | Details |
| --- | --- |
| Target OS | AlmaLinux, Rocky Linux or RHEL 9/10 for automatic Docker installation |
| Architecture | x86-64 (`linux/amd64`) |
| Initial resources | 4 CPU cores, 8 GB RAM and 30 GB+ free disk |
| Installer | Git, Python 3.11+ with `venv`, SSH for remote deployment |
| Target access | sudo privileges; Python 3 available for Ansible |
| Network | Internet access to download packages, dependencies and images |

Allow additional storage for metrics retention and container image caches.

### 1. Clone Ops Center

```bash
git clone https://github.com/r0lfi/ops-center.git
cd ops-center
```

### 2. Install

The default inventory installs Ops Center on the machine running the installer.

```bash
bash scripts/install.sh --ask-become-pass
```

For passwordless sudo:

```bash
bash scripts/install.sh
```

During installation, choose an Ops Center administrator username and a password of at least 12 characters.

The installer:

1. Installs and starts Docker Engine and Compose from Docker's official RPM repository.
2. Copies Ops Center to `/opt/ops-center` and creates persistent storage under `/var/lib/ops-center`.
3. Generates PostgreSQL, Redis, API-signing and Grafana credentials in `/opt/ops-center/.env` with mode `0600`.
4. Builds the five application images and downloads upstream service images.
5. Starts the services, runs database migrations and waits for health checks.
6. Creates the initial administrator account and stores its password as a hash in PostgreSQL.

You do not need AI API keys for the initial installation. Conflicting container packages must be resolved manually. The playbook does not disable SELinux or automatically open firewall ports.

**Never publish `/opt/ops-center/.env`.**

### 3. Access Ops Center

By default, the web interface binds to `127.0.0.1:8080`.

From your workstation:

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

Open:

```text
http://localhost:8080
```

Grafana is available at `/grafana/` with a separate generated administrator password.

For shared or production access, configure an HTTPS reverse proxy to `127.0.0.1:8080`. Do not expose API or authentication credentials over an untrusted plain HTTP connection.

---

## 🖥️ Remote Installation

```bash
cp deploy/inventory.example.ini deploy/inventory.ini
# Edit inventory.ini: remove localhost and enter your SSH target.

bash scripts/install.sh -i deploy/inventory.ini --ask-become-pass \
  -e ops_timezone=UTC \
  -e ops_http_port=8080
```

### Installation variables

| Variable | Default | Description |
| --- | --- | --- |
| `ops_install_dir` | `/opt/ops-center` | Application installation directory |
| `ops_data_root` | `/var/lib/ops-center` | Persistent data |
| `ops_timezone` | `UTC` | Scheduler timezone |
| `ops_bind_address` | `127.0.0.1` | Web listen address |
| `ops_http_port` | `8080` | Web interface port |
| `ops_install_docker` | `true` | Install Docker automatically |
| `ops_build_images` | `true` | Build application images locally |
| `ops_image_prefix` | `ops-center` | Container image prefix |
| `ops_image_tag` | `local` | Container image tag |

With an existing Docker Engine and Compose v2 installation:

```bash
bash scripts/install.sh --ask-become-pass \
  -e ops_install_docker=false
```

Rootless Podman is currently **not** a supported deployment target.

Re-running preserves the existing `.env` and administrator credentials. Back up your installation before upgrades.

---

## 🔐 Unattended Installation

For unattended deployments, provide administrator credentials using an **Ansible Vault-encrypted variable file**:

```bash
bash scripts/install.sh \
  -e @/secure/path/bootstrap.yml \
  --ask-vault-pass
```

Do not place passwords in command-line `-e` strings or commit private inventory/variable files.

---

## HA / cluster installation

The public release now includes a configurable two-node application/database
cluster with a third witness, PostgreSQL/Patroni + etcd, Redis/Sentinel, and local
HAProxy database routing. The Cluster page displays the configured members and
allows administrators to request PostgreSQL switchover.

Follow **[the HA installation and failover guide](docs/ha.md)** for requirements,
private inventory generation, the `deploy/ha.yml` Ansible preparation playbook,
startup order, backups and tests. The regular installer remains single-server.
HA configuration is generated with fresh secrets outside the repository; no
existing installation data is included. Redundant ingress, secure file
synchronization and HA monitoring require additional configuration as described
in the guide.

The AI menu also includes searchable technical documentation explaining agents,
tools, approval handling, memory and the application runtime.

---

## 🐳 Container Images

Ops Center builds five custom application images:

| Image | Purpose |
| --- | --- |
| `api` | FastAPI backend and database migrations |
| `frontend` | Compiled React web interface served by Nginx |
| `worker` | Ansible execution and scheduler |
| `ai-worker` | Optional AI agent execution |
| `security-worker` | Security scanning and Docker operations |

The image helper and GitHub image workflow also build `postgres-ha`, the optional
PostgreSQL 17/Patroni image used by the [HA deployment](docs/ha.md).

The repository contains source code and Dockerfiles rather than prebuilt image archives. Building during installation is the default.

### Build and publish images

```bash
export IMAGE_PREFIX=ghcr.io/r0lfi/ops-center
export IMAGE_TAG=0.1.0
bash scripts/images.sh build
```

Only when you intentionally want to publish:

```bash
docker login ghcr.io
bash scripts/images.sh push
```

For local Podman builds, set `CONTAINER_ENGINE=podman`. This builds images only; standard deployment uses Docker Engine.

### Install using published images

```bash
bash scripts/install.sh --ask-become-pass \
  -e ops_build_images=false \
  -e ops_image_prefix=ghcr.io/r0lfi/ops-center \
  -e ops_image_tag=0.1.0
```

Authenticate Docker on the target first if the packages are private.

---

## 🔧 First Configuration

After installation:

1. Sign into Ops Center.
2. Add the Linux systems you want to manage.
3. Configure SSH credentials.
4. Configure optional integrations.
5. Configure an AI provider if AI functionality is required.

Private SSH keys and passwords belong in runtime secrets and must **never be committed to Git**.

A helper script is available for generating an SSH key:

```bash
scripts/credentials/generate-ssh-key.sh
```

Only authorize the generated public key on hosts Ops Center should manage.

---

## 🔌 Optional Integrations

Depending on your environment, Ops Center can integrate with additional services such as:

- AI providers
- Nextcloud Talk
- Cameras
- VPN services
- SSH targets
- Traffic-map sources

These integrations require your own accounts, infrastructure and configuration.

See:

- [Integrations](docs/integrations.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)

---

## 📁 Repository Structure

```text
ops-center/
├── frontend/          React / TypeScript frontend
├── backend/           FastAPI backend
├── worker/            Ansible execution and scheduler
├── worker_ai/         AI agents, providers and tools
├── security/          Security and Docker operations
├── ansible/           Infrastructure automation
├── deploy/            Ansible installation
├── monitoring/        Prometheus/Grafana configuration
├── proxy/             Caddy reverse proxy
├── scripts/           Installation and development tools
├── docs/              Documentation
└── .github/workflows/ GitHub Actions
```

---

## 🧪 Development and Validation

Frontend development requires Node.js 22 and npm. Python components require Python 3.11 or newer.

```bash
cd frontend
npm ci
npm run build
cd ..
bash scripts/test/run-tests.sh
```

Before publishing source or a release:

```bash
python3 scripts/check-release.py
gitleaks dir . --redact
gitleaks git . --redact
python3 scripts/package.py /tmp/ops-center-release.tar.gz
```

Automated scanning cannot guarantee that arbitrary new content contains no sensitive information. Always review changes before publishing.

Never publish:

- `.env`
- SSH private keys
- Database dumps
- Backups
- Private inventories
- Credentials or API keys
- Screenshots containing private infrastructure information

Enable GitHub Secret Scanning and Push Protection where available.

See [validation results](docs/validation.md) for current validation information.

---

## ⚠️ Project Status

Ops Center is currently under active development.

Image builds, Python tests, the frontend build and Ansible syntax validation have been tested. The complete installer is still being validated across clean server deployments.

The standard installer targets a **single Ops Center server**. An optional two-node deployment with a witness is provided in the [HA / cluster installation guide](docs/ha.md).

Before production use:

- Test it in a lab environment.
- Review the security configuration.
- Back up persistent data.
- Validate automation against non-critical systems first.

---

## 🗺️ Roadmap

- [ ] Improved AI agent orchestration
- [ ] More infrastructure agents
- [ ] Expanded Linux distribution support
- [ ] Kubernetes integration
- [ ] Improved container management
- [ ] GPU infrastructure monitoring
- [ ] Better Operations Floor visualization
- [ ] Additional monitoring integrations
- [ ] Additional security integrations
- [ ] More automation workflows
- [ ] Role-based agent access
- [ ] Multi-user improvements
- [ ] Easier deployment
- [ ] Prebuilt container releases
- [ ] High-availability deployment options

Ideas and contributions are welcome.

---

## 🤝 Contributing

Contributions, testing and feedback are welcome.

You can help by:

- Reporting bugs
- Testing installation on different Linux systems
- Suggesting features
- Improving documentation
- Creating integrations
- Adding automation
- Improving the frontend
- Submitting pull requests

For installation problems, include the operating system, Docker/Compose versions and relevant **redacted** error output.

Never include credentials, private hostnames, private IP addresses, SSH keys or other sensitive infrastructure information.

---

## 🔒 Security

Ops Center can execute infrastructure operations and should be treated as a **privileged management system**.

Recommended practices:

- Run it on dedicated infrastructure.
- Restrict network access.
- Use HTTPS.
- Protect administrator credentials.
- Restrict SSH keys.
- Use least privilege where possible.
- Never expose runtime secrets publicly.
- Test automation before targeting production systems.
- Keep the host and container images patched.

See [security guidance](docs/security.md).

---

## 📜 License

Ops Center application code is distributed under the [MIT License](LICENSE).

Third-party libraries, images and geographic data retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## ⭐ Support the Project

If you find Ops Center interesting or useful, consider giving the repository a **star ⭐**.

It helps other Linux, DevOps, self-hosting and infrastructure users discover the project.

Contributions, ideas and feedback are very welcome.

---

<p align="center">
  <strong>Built for people who would rather manage infrastructure than manage ten different dashboards.</strong>
</p>
