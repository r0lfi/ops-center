# 🚀 Ops Center

### Self-hosted AI-assisted operations platform for Linux, containers, automation, monitoring, security and high availability.

<p align="center">
  <strong>Linux • Docker • Ansible • Monitoring • Security • HA • Automation • AI Agents</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Self--Hosted-Yes-success" alt="Self Hosted">
  <img src="https://img.shields.io/badge/HA-Patroni%20%7C%20etcd%20%7C%20Sentinel-success" alt="High Availability">
  <img src="https://img.shields.io/badge/Linux-RHEL%20%7C%20AlmaLinux%20%7C%20Rocky-orange" alt="Linux">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/Ansible-Automation-EE0000?logo=ansible&logoColor=white" alt="Ansible">
  <img src="https://img.shields.io/badge/AI-Agents-8A2BE2" alt="AI Agents">
</p>

---

## What is Ops Center?

**Ops Center** is an open-source, self-hosted operations platform that brings infrastructure management, automation, observability, security and AI-assisted operations into one interface.

Instead of constantly switching between monitoring dashboards, Ansible, vulnerability scanners, Docker tools, SSH sessions and AI assistants, Ops Center brings them together into a single operations environment.

It is designed primarily for **Linux administrators, DevOps engineers, homelab users and infrastructure teams**.

Ops Center combines:

- 🐧 Linux server management
- 🐳 Docker workload management
- ⚙️ Ansible automation
- 📊 Monitoring and observability
- 🔐 Vulnerability and security scanning
- 🔄 Patching and scheduled operations
- 🛡️ Optional HA / cluster deployment
- 🤖 AI-assisted infrastructure operations
- 🛰️ Interactive **2D and 3D Operations Floor**
- 💬 Agent chat and task interaction
- 📡 Optional integrations such as Nextcloud Talk and external AI providers

> **Project status:** Ops Center is under active development. Validate it in a lab environment before using it against production infrastructure.

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

### 🛡️ High Availability / Cluster

Ops Center includes an optional portable HA reference deployment for **two application/database nodes plus an independent witness**.

- Active application stack on both app nodes
- PostgreSQL 17 HA with **Patroni**
- **etcd** three-member quorum across both app nodes and the witness
- PostgreSQL primary/replica streaming replication
- Local **HAProxy `pg-router`** on each application node that follows the Patroni primary
- Redis primary/replica topology
- **Redis Sentinel** on both app nodes plus the witness, quorum 2
- Redis/Celery primary discovery through Sentinel
- RedBeat shared scheduling lock across application nodes
- Cluster status page for PostgreSQL and Redis health
- Administrative PostgreSQL **switchover from the UI**
- Fresh HA topology and credentials generated outside the repository
- Ansible-based preparation using `deploy/ha.yml`

The witness participates in quorum but holds no PostgreSQL data or application signing credentials.

The reference HA bundle deliberately leaves external application ingress to the operator. In the author's deployment, **Nginx Proxy Manager is placed behind a floating application VIP** to provide a stable HTTPS endpoint in front of both active application nodes. This is a deployment example rather than a hard dependency: the public HA bundle does **not** automatically provision Nginx Proxy Manager, the floating application VIP, keepalived or another redundant external load balancer. Operators can provide an equivalent redundant ingress design that fits their environment.

HA monitoring storage is also not shared automatically; Prometheus, Loki and related local data remain node-local in the reference topology.

See **[HA / cluster deployment](docs/ha.md)** for the complete topology, network boundaries, failover tests, backup guidance and upgrade procedure.

### AI

AI functionality is optional — **Ops Center can operate without an AI provider configured**.

The architecture includes a dedicated AI worker and provider integrations while keeping infrastructure execution separated into specialized workers. Bring your own provider credentials.

---

## 🏗️ Architecture

### Standard deployment

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

### HA / cluster deployment

```text
                           HTTPS clients
                                │
                   ┌────────────▼────────────┐
                   │ Floating app VIP        │
                   │ + Nginx Proxy Manager   │
                   │ (author deployment)     │
                   └────────────┬────────────┘
                                │
                   redundant ingress to app tier
                                │
                    ┌───────────┴───────────┐
                    │                       │
             ┌──────▼──────┐         ┌──────▼──────┐
             │  App Node 1 │         │  App Node 2 │
             │             │         │             │
             │ API         │         │ API         │
             │ Frontend    │         │ Frontend    │
             │ Workers     │         │ Workers     │
             │ Scheduler   │         │ Scheduler   │
             │ AI/Security │         │ AI/Security │
             └──────┬──────┘         └──────┬──────┘
                    │                       │
          local pg-router:5432    local pg-router:5432
                    │                       │
                    └───────────┬───────────┘
                                │
                    ┌───────────▼────────────┐
                    │ PostgreSQL / Patroni   │
                    │ Primary ⇄ Hot Replica  │
                    └───────────┬────────────┘
                                │
                       etcd consensus/quorum
                    ┌───────────┼───────────┐
                    │           │           │
               App Node 1  App Node 2    Witness

                    ┌───────────────────────────────┐
                    │           Redis HA            │
                    │   Primary ⇄ Hot Replica       │
                    │                               │
                    │ Sentinel + Sentinel + Witness │
                    │           quorum 2            │
                    └───────────────────────────────┘
```

The **floating application VIP + Nginx Proxy Manager** shown above documents the author's production-style ingress pattern. It is intentionally external to the portable HA bundle; another redundant reverse proxy/load balancer design can be used instead.

Each application node routes database traffic through its local HAProxy endpoint, which checks Patroni and follows the current PostgreSQL primary. Redis-aware clients and Celery discover the current Redis primary through Sentinel.

---

## 🧰 Technology Stack

**Frontend:** React, TypeScript  
**Backend:** FastAPI, Python  
**Automation:** Ansible  
**Containers:** Docker, Docker Compose  
**Data:** PostgreSQL, Redis  
**HA:** Patroni, etcd, HAProxy, Redis Sentinel, RedBeat  
**Example redundant ingress:** Nginx Proxy Manager + floating VIP  
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
4. Builds the application images and downloads upstream service images.
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

Open `http://localhost:8080` and sign in with the administrator account you created.

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

## 🛡️ HA / Cluster Installation

The public distribution includes a generator and Ansible preparation playbook for **two application/database hosts and one independent witness**. The ordinary `deploy/install.yml` remains the single-server installer.

The HA generator creates fresh credentials and configuration from your own inventory and deliberately keeps generated secrets outside the repository.

High-level flow:

```bash
python3 -m venv .venv-installer
.venv-installer/bin/pip install 'ansible-core==2.18.19'
.venv-installer/bin/python scripts/ha/generate.py ../ha-inventory.json ../ha-runtime
python3 scripts/package.py /tmp/ops-center-public.tar.gz

.venv-installer/bin/ansible-playbook \
  -i ../ha-hosts.ini \
  deploy/ha.yml \
  --ask-become-pass \
  -e ops_release_archive=/tmp/ops-center-public.tar.gz \
  -e ops_ha_bundle="$(realpath ../ha-runtime)"
```

The HA preparation playbook installs the generated configuration but **does not start the services**. Follow the documented startup order so Patroni/etcd and Redis/Sentinel establish healthy quorum before both application nodes are brought online.

Application ingress is deliberately external to this bundle. The author's deployment uses **Nginx Proxy Manager behind a floating VIP** in front of both application nodes. You can reproduce that pattern or use another redundant HTTPS reverse proxy/load balancer appropriate for your environment.

For network requirements, port restrictions, startup order, switchover testing, failover behavior, backups and upgrades, follow the complete **[HA installation and failover guide](docs/ha.md)**.

> HA improves service availability but is not a zero-downtime or exactly-once guarantee. PostgreSQL replication is asynchronous by default, Celery jobs may be redelivered after failures, and monitoring data remains local to each node in the reference architecture.

---

## 🐳 Container Images

Ops Center builds these custom application images:

| Image | Purpose |
| --- | --- |
| `api` | FastAPI backend and database migrations |
| `frontend` | Compiled React web interface served by Nginx |
| `worker` | Ansible execution and scheduler |
| `ai-worker` | Optional AI agent execution |
| `security-worker` | Security scanning and Docker operations |
| `postgres-ha` | PostgreSQL 17 + Patroni image for the optional HA deployment |

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
- [HA / cluster deployment](docs/ha.md)

---

## 📁 Repository Structure

```text
ops-center/
├── frontend/          React / TypeScript frontend
├── backend/           FastAPI backend and Cluster API
├── worker/            Ansible execution and scheduler
├── worker_ai/         AI agents, providers and tools
├── security/          Security and Docker operations
├── ansible/           Infrastructure automation
├── deploy/            Standard + HA Ansible deployment
├── ha/                HA PostgreSQL/Patroni image and supporting files
├── monitoring/        Prometheus/Grafana configuration
├── proxy/             Caddy reverse proxy
├── scripts/ha/        Portable HA topology/config generator
├── scripts/           Installation, testing and packaging tools
├── docs/              Documentation including HA deployment
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

CI validates both the standard installer and HA installer Ansible syntax.

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
- HA runtime bundles or generated HA inventories
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

The standard installer targets a **single Ops Center server**. The repository also contains an optional portable **two-node HA application/database deployment with an independent witness**.

Before production use:

- Test it in a lab environment.
- Review the security configuration and HA network boundary.
- Back up persistent data and private HA configuration.
- Validate automation against non-critical systems first.
- Test failover and restoration procedures in a disposable environment.

---

## 🗺️ Roadmap

### Implemented

- [x] Linux server operations
- [x] Docker workload management
- [x] Ansible automation
- [x] Monitoring and observability stack
- [x] Vulnerability scanning
- [x] AI-assisted operations
- [x] 2D / 3D Operations Floor
- [x] PostgreSQL HA with Patroni + etcd
- [x] Redis HA with Sentinel
- [x] Two-node application topology with witness quorum
- [x] Cluster status UI
- [x] Administrative PostgreSQL switchover
- [x] Portable HA configuration generator and Ansible preparation

### Planned / evolving

- [ ] Improved AI agent orchestration
- [ ] More infrastructure agents
- [ ] Expanded Linux distribution support
- [ ] Kubernetes integration
- [ ] Improved container management
- [ ] GPU infrastructure monitoring
- [ ] Better Operations Floor visualization
- [ ] Dedicated HA monitoring / shared observability storage
- [ ] More automation workflows
- [ ] Role-based agent access
- [ ] Multi-user improvements
- [ ] Easier deployment and upgrades
- [ ] Prebuilt container releases

Ideas and contributions are welcome.

---

## 🤝 Contributing

Contributions, testing and feedback are welcome.

You can help by reporting bugs, testing installation and HA behavior on different Linux systems, suggesting features, improving documentation, creating integrations, adding automation, improving the frontend or submitting pull requests.

For installation problems, include the operating system, Docker/Compose versions and relevant **redacted** error output. Never include credentials, private hostnames, inventories, SSH keys, HA runtime bundles or runtime data.

---

## 🔒 Security

Ops Center can execute infrastructure operations and should be treated as a **privileged management system**.

- Run it on dedicated infrastructure.
- Restrict network access.
- Use HTTPS.
- Protect administrator credentials and SSH keys.
- Use least privilege where possible.
- Never expose runtime or HA-generated secrets publicly.
- Test automation before targeting production systems.
- Keep the host and container images patched.
- For HA, isolate cluster traffic and source-restrict etcd, PostgreSQL, Patroni, Redis and Sentinel ports.

The reference HA topology intentionally does not add authentication to etcd/Sentinel or TLS to cross-host traffic, so those services must remain on an isolated trusted network unless you add stronger transport/security controls.

See [security guidance](docs/security.md) and [HA network guidance](docs/ha.md).

---

## 📜 License

Ops Center application code is distributed under the [MIT License](LICENSE). Third-party libraries, images and geographic data retain their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## ⭐ Support the Project

If you find Ops Center interesting or useful, consider giving the repository a **star ⭐**.

It helps other Linux, DevOps, self-hosting and infrastructure users discover the project. Contributions, ideas and feedback are very welcome.

---

<p align="center"><strong>Built for people who would rather manage infrastructure than manage ten different dashboards.</strong></p>