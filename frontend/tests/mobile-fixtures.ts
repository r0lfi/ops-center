import type { Page } from "@playwright/test";

/** Worst-case data for layout checks: long names, long values, full lists. Synthetic throughout. */
const now = new Date().toISOString();
const NAME = "example-production-database-cluster-node";
const LONG = `${NAME}-01.internal.example.test`;
const IMAGE = "registry.internal.example.test/platform/observability/very-long-image-name-for-testing:1.25.3-alpine3.20";
const CVE = "CVE-2026-1234567";
const IDS = Array.from({ length: 24 }, (_, i) => i + 1);
const points = (base: number): [number, number][] => Array.from({ length: 40 }, (_, i) => [Math.floor(Date.now() / 1000) - (40 - i) * 60, base + Math.sin(i / 3) * 10]);
const series = (base: number, labels: Record<string, string> = { device: "/dev/mapper/almalinux-root", mountpoint: "/var/lib/containers/storage/overlay" }) => [{ labels, points: points(base) }];
const metrics = { cpu: series(40), memory: series(60), disk: series(70), disk_bytes: series(5e10), disk_total: series(1e11), inodes: series(20), network_rx: series(1e6), network_tx: series(2e6), uptime: series(86400), last_sample: series(1) };
const steps = ["verify_network", "verify_ssh"].map((step) => ({ step, status: "ok", detail: "", started_at: now, finished_at: now }));

const host = (i: number) => ({
  id: `h${i}`, hostname: `${NAME}-${i}`, fqdn: `${NAME}-${i}.internal.example.test`, ip_address: `2001:db8:1234:5678:9abc:def0:1234:${i}`, monitoring_ip_address: null,
  ssh_port: 22, ssh_user: "ansible-automation-service", credential_id: "c1", operating_system: "AlmaLinux Enterprise Server", os_version: "10.1 (Heliotrope Lion)", environment: i % 2 ? "production" : "staging",
  location: "Datacenter North, Rack 14, Unit 22", latitude: 59.9, longitude: 10.7, group_ids: ["g1"], criticality: "high", description: "Primary database host for the long running reporting workloads",
  auto_patch: true, security_patch_policy: "auto", reboot_policy: "manual", patch_window: "Sun 03:00-05:00", monitoring_enabled: true, log_collection_enabled: true, is_docker_host: true,
  ssh_host_fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH", reboot_required: i % 3 === 0, date_added: now, last_seen: now, last_ansible_run: now,
  tags: ["production", "database", "critical-workload", "europe-north"], onboarding_steps: steps,
});
const container = (i: number) => ({ id: `c${i}`, hostname: `${NAME}-${i % 3}`, name: `a-container-with-a-very-long-name-that-should-not-widen-the-page-${i}`, image: IMAGE, status: i % 5 ? "running" : "exited", health: i % 4 ? "healthy" : "unhealthy", restart_count: i, last_seen: now, vulnerability_count: 12, critical_vulnerability_count: 2 });
const alert = (i: number) => ({ fingerprint: `a${i}`, labels: { alertname: "ContainerRestartingTooOftenOnProductionHost", severity: i % 2 ? "critical" : "warning", hostname: LONG, instance: `${LONG}:9100` }, annotations: { summary: `Container restarted too often on ${LONG}`, description: "x".repeat(160) }, startsAt: now, endsAt: now, generatorURL: "", status: { state: "active" } });
const job = (i: number) => ({ id: `j${i}`, user: "administrator", playbook: "patch-security-with-extended-reboot-handling.yml", target_description: `${NAME}-${i},${NAME}-${i + 1},${NAME}-${i + 2}`, limit: null, extra_vars: {}, status: ["successful", "failed", "running"][i % 3], started_at: now, finished_at: now, changed_hosts: 3, successful_hosts: 3, failed_hosts: 1, unreachable_hosts: 0, created_at: now, events: [] });
const longLine = `TASK [install security updates] fatal: [${LONG}]: FAILED! => ${"a-very-long-unbroken-output-token-".repeat(12)}`;
const events = Array.from({ length: 30 }, (_, i) => ({ sequence: i, event_type: "runner_on_ok", host: LONG, task: "Install security updates on the host", message: longLine, created_at: now }));
const group = (i: number) => ({ id: `g${i}`, name: `a-patch-group-with-quite-a-long-name-${i}`, description: "Weekly maintenance for the production database cluster", cron_expression: "0 3 * * 1", patch_type: "security", batch_size: 2, schedule_enabled: true, last_triggered_at: now, hosts: IDS.slice(0, 6).map((n) => ({ id: `h${n}`, hostname: `${NAME}-${n}` })) });
const vuln = (i: number) => ({ id: `v${i}`, cve_id: `${CVE}${i}`, package_name: "kernel-modules-extra-matched-long-package-name", severity: ["critical", "high", "medium"][i % 3], cvss_score: 9.8, fixed_version: "6.12.0-211.69.1.el10_2.x86_64", fix_available: true, source: "trivy-and-distribution-feed", cisa_kev: i % 4 === 0, epss_score: 0.97, first_seen: now, last_seen: now, affected_hosts: IDS.slice(0, 4).map((n) => ({ id: `h${n}`, hostname: `${NAME}-${n}`, installed_version: "6.12.0-1" })), affected_containers: [{ name: container(1).name, hostname: LONG, image: IMAGE, installed_version: "1.0" }], priority_level: "P1", priority_score: 98 });
const advisory = (i: number) => ({ id: `ad${i}`, source: "almalinux-errata", advisory_id: `ALSA-2026:${i}1234`, title: "Important: kernel security, bug fix, and enhancement update for extended support", severity: "critical", published_at: now, cve_ids: [`${CVE}1`, `${CVE}2`], packages: ["kernel-modules-extra-matched-long-package-name"], url: "https://errata.example.test/ALSA-2026", affected_hosts: [{ id: "h1", hostname: LONG, installed_version: "1" }] });
const agent = (slug: string, extra: Record<string, unknown> = {}) => ({ id: `id-${slug}`, slug, name: `${slug} Agent`, description: "Investigates infrastructure issues across the production estate", responsibility: "Responsible for keeping the production estate healthy and patched", status: "idle", current_task: null, error_message: null, provider_id: "p1", model: "a-very-long-model-identifier-2026-11-01", system_prompt: "You are an agent.", allowed_tools: ["hosts.list", "containers.restart", "patching.install_security", "monitoring.query"], allowed_hosts: [], allowed_environments: [], autonomy_level: 2, max_tool_calls: 8, max_execution_seconds: 300, enabled: true, runtime: "native", allowed_dispatch_targets: null, personal: false, last_activity_at: now, updated_at: now, ...extra });
const task = (i: number) => ({ id: `t${i}`, agent_id: "id-coordinator", requested_by: "administrator", source: "web", conversation_key: "c", input_message: `Investigate why ${LONG} keeps restarting and report what you find.`, response_message: `The host ${LONG} restarted because ${"x".repeat(200)}`, status: ["completed", "failed", "running"][i % 3], error_message: null, agents_used: ["linux", "monitoring"], tools_used: [{ tool: "hosts.list", arguments: { host: LONG } }], data_sources: ["prometheus", "loki"], confidence: 80, started_at: now, completed_at: now, duration_ms: 12000, created_at: now });
const action = (i: number) => ({ id: `ac${i}`, request_code: `REQ-${i}`, agent_id: "id-linux", task_id: "t1", host_id: "h1", action: "restart_service_on_host", tool: "services.restart", arguments: { host: LONG, service: "postgresql-primary-replication.service" }, approval_level: 2, risk: "high", reason: "The service has stopped responding", status: "pending", source: "web", requested_by: "administrator", approved_by: null, result: null, requested_at: now, expires_at: now, approved_at: null, executed_at: null });
const camera = (i: number) => ({ name: `Camera with a long descriptive name ${i}`, ip: "192.0.2.10", kind: "tapo", reachable: i % 2 === 0, consecutive_fails: 1, cooldown_remaining_seconds: null, last_kick_at: now, last_kick_result: "kicked", has_stream: false });
const peer = (i: number) => ({ id: `vp${i}`, name: `a-long-vpn-peer-name-for-a-laptop-${i}`, address: "198.51.100.123/32", enabled: true, latest_handshake_at: now, transfer_rx: 123456789, transfer_tx: 987654321, note: "Laptop used when travelling" });
const native = (i: number) => ({ id: `h${i}`, hostname: `${NAME}-${i}`, ip_address: "192.0.2.1", operating_system: "AlmaLinux", os_version: "10.1", monitoring_enabled: true, log_collection_enabled: true, is_docker_host: true, container_inventory_at: now, status: "ok", last_sample: Date.now() / 1000, metrics, alerts: [{ name: "HighLoad", severity: "warning", summary: "Load is high", starts_at: now }], services: [{ id: "s1", target: "postgresql-primary-replication.service", check_type: "systemd", enabled: true }] });
const nativeContainer = (i: number) => ({ id: `nc${i}`, host_id: "h1", hostname: LONG, runtime_id: "abc", name: container(i).name, image: IMAGE, status: "running", health: "healthy", restart_count: 2, last_seen: now, metadata: { stack: "observability-stack", started_at: now, exit_code: 0, memory_limit: 1e9, nano_cpus: 2e9, runtime_stats: { cpu_percent: 12, memory_bytes: 5e8, network_io: "1.2GB / 3.4GB", block_io: "5MB / 6MB", captured_at: now }, ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }, networks: ["a-long-docker-network-name"], mounts: [{ Type: "bind", Source: "/data/applications/observability/very/long/source/path", Destination: "/var/lib/application/data", RW: true }] }, metrics, errors: {}, metrics_state: "ok" });
const trafficEvent = (i: number) => ({ id: `te${i}`, kind: "http", ts: Date.now() / 1000 - i, ip: "2001:db8:1234:5678:9abc:def0:1234:1", lat: 59.9, lon: 10.7, city: "Oslo", country: "Norway", domain: "a-very-long-domain-name.example.test", status: 200, source: "npm", suspicious: i % 5 === 0, signal: null });
const logLines = Array.from({ length: 40 }, (_, i) => ({ timestamp: String(Date.now() * 1e6 - i), labels: { host: LONG, service: "postgresql", level: "error" }, line: longLine }));
const summary = { total_vulnerabilities: 123456, critical: 12345, high: 2345, kev: 123, fix_available: 8901, affected_hosts: 42, affected_containers: 321, new_critical_advisories: 5, new_kev_entries: 2, sources: [{ name: "cisa-known-exploited-vulnerabilities", status: "ok", last_success_at: now, last_error: null, records_last_run: 1234 }, { name: "almalinux-errata", status: "error", last_success_at: now, last_error: "Timed out while reading the feed from upstream", records_last_run: 0 }] };
const postgres = { scope: "ops-center-postgres-high-availability", vip: "198.51.100.19", vip_holder: LONG, nodes: [{ name: LONG, host: "198.51.100.11", role: "Leader", state: "running", timeline: 12, lag: 0 }, { name: `${NAME}-02`, host: "198.51.100.12", role: "Replica", state: "streaming", timeline: 12, lag: 1024 }] };
const redis = { master_name: "ops-center-redis-master", master: LONG, nodes: [{ host: LONG, role: "master", connected: true }], sentinels: [{ host: "sentinel-with-a-long-name-01", port: 26379, reachable: true }] };

const devChange = (i: number, stage: string) => ({
  id: `00000000-0000-0000-0000-00000000000${i}`, title: `Tool ${LONG} read-only log search ${i}`, status: stage === "working" ? "in_development" : stage,
  stage, summary: `Agents cannot search ${LONG} without shell access`, proposed_by: "Monitoring", runs: 2, files: 4, added: 1234, removed: 56,
  developer_run: { id: "11111111-1111-1111-1111-111111111111", status: stage === "working" ? "running" : "completed", outcome: null, requested_by: "admin",
    created_at: now, started_at: now, completed_at: null, duration_ms: null, tools_used: 9, error: null },
  has_patch: stage !== "working", patch_sha256: "a".repeat(64), approved_by: stage === "approved" ? "admin" : null, approved_at: null,
  release_ref: null, branch: "tool-proposal/00000000", created_at: now, updated_at: now, started_at: now, finished_at: null,
});
const mapGroup = (i: number, scope: string, status: string) => ({
  key: `g${i}`, agent: i % 3 ? `agent-${NAME}` : null, process: "celery", node: "docker-host-01", container: "ops-center-ai-worker", model: null, provider: null,
  tool: null, mcp_tool: null, src_ip: "203.0.113.18", src_count: 1, dst_ip: scope === "external" ? "192.0.2.10" : "198.51.100.145", dst_port: 6379 + i,
  dst_host: scope === "external" ? LONG : null, protocol: "tcp", kind: "tcp", status, outcomes: [status === "ok" ? "ok" : "timeout"], reason: null,
  count: 123456, bytes_sent: 1e9, bytes_recv: 2e9, unmeasured: 0, first_seen: now, last_seen: now, last_id: i, scope,
  category: i % 3 ? "ai" : "system", direction: "outbound", service: scope === "external" ? null : "Redis",
  geo: scope === "external" ? { lat: 50.1, lon: 8.7, city: "Frankfurt am Main", country: "Germany" } : null,
});

const exact: Record<string, unknown> = {
  "/api/ai/developer/overview": {
    agent: { name: "Developer", status: "working", activity: "Analysing results", enabled: true, configured: true },
    counts: { working: 1, ready_for_review: 1, approved: 1 }, can_decide: true,
    items: [devChange(1, "working"), devChange(2, "ready_for_review"), devChange(3, "approved")],
  },
  "/api/ai-traffic/map": {
    since: now, generated_at: now, truncated: true, group_limit: 1500, geoip: true, sites: { "docker-host-01": { lat: 59.9, lon: 10.7 } },
    groups: [mapGroup(1, "external", "ok"), mapGroup(2, "external", "blocked"), mapGroup(3, "internal", "ok"), mapGroup(4, "internal", "failed"), mapGroup(5, "unknown", "blocked")],
    countries: [{ country: "Germany", count: 246912, bytes: 6e9, problems: 123456 }],
    coverage: [{ node: null, area: "Firewall drop logs (rule that blocked)", status: "missing", detail: "Not exported" }],
  },
  "/api/hosts": IDS.map(host),
  "/api/containers": IDS.map(container),
  "/api/alerts": { available: true, alerts: IDS.slice(0, 12).map(alert) },
  "/api/jobs": IDS.map(job),
  "/api/host-groups": [1, 2, 3].map(group),
  "/api/credentials": [{ id: "c1", name: "a-credential-with-a-long-descriptive-name", description: "Used by automation", credential_type: "ssh_key", ssh_user: "ansible-automation-service", public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI".padEnd(90, "x"), public_key_fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" }],
  "/api/cluster/status": { postgres, redis },
  "/api/cameras/status": [1, 2, 3, 4].map(camera),
  "/api/vpn/peers": [1, 2, 3].map(peer),
  "/api/users": [{ id: "u1", username: "administrator-with-long-name", role: "admin", is_active: true, created_at: now, last_login_at: now }],
  "/api/audit": IDS.map((i) => ({ id: `al${i}`, username: "administrator", action: "hosts.update.configuration", target: LONG, detail: "x".repeat(120), created_at: now, timestamp: now })),
  "/api/automation/playbooks": ["patch-security-with-extended-reboot-handling.yml", "update-pihole.yml"],
  "/api/ansible/playbooks": ["patch-security-with-extended-reboot-handling.yml", "update-pihole.yml"],
  "/api/services": IDS.slice(0, 8).map((i) => ({ id: `s${i}`, host_id: `h${i}`, check_type: "systemd", target: "postgresql-primary-replication.service", enabled: true, created_at: now })),
  "/api/security/vulnerabilities": IDS.map(vuln),
  "/api/security/attention": IDS.slice(0, 8).map(vuln),
  "/api/security/advisories": IDS.slice(0, 8).map(advisory),
  "/api/security/summary": summary,
  "/api/docker-hosts": IDS.slice(0, 6).map((i) => ({ hostname: `${NAME}-${i}`, ip_address: "192.0.2.1", environment: "production", container_count: 123, running_count: 120, stopped_count: 3, unhealthy_count: 1, last_seen: now })),
  "/api/registries": [{ id: "r1", name: "an-internal-registry-with-a-long-name", url: "https://registry.internal.example.test/v2/platform", username: "automation-service", auth_required: true, description: "Internal images", created_at: now }],
  "/api/app-catalog/settings": { template_url: "https://templates.example.test/portainer/v3/a-long-template-file-name.json" },
  "/api/app-catalog/templates": IDS.slice(0, 8).map((i) => ({ id: i, type: 3, title: `An application template with a long title ${i}`, description: "x".repeat(120), categories: ["monitoring", "database"], logo: null, note: null, platform: "linux", env: [] })),
  "/api/monitoring/fleet": { hosts: IDS.slice(0, 6).map(native), containers: IDS.slice(0, 12).map(nativeContainer), errors: {}, container_errors: {}, alerts_available: true },
  "/api/logs": { available: true, state: "ok", source: "loki", levels: ["error"], lines: logLines, next_cursor: null },
  "/api/logs/query": { available: true, state: "ok", source: "loki", levels: ["error"], lines: logLines, next_cursor: null },
  "/api/metrics/hosts": { available: true, cpu: [{ instance: LONG, points: points(40) }], memory: [{ instance: LONG, points: points(50) }], disk: [{ instance: LONG, points: points(60) }], network_rx: [{ instance: LONG, points: points(1e6) }], network_tx: [{ instance: LONG, points: points(2e6) }] },
  "/api/metrics/services": { available: true, services: [{ service: "a-long-monitored-service-name", up: true, latency_ms: 12 }, { service: "grafana", up: false, latency_ms: null }] },
  "/api/patches": IDS.map((i) => ({ id: `pa${i}`, host_id: `h${i}`, package_name: "kernel-modules-extra-matched-long-package-name", installed_version: "6.12.0-1.el10", fixed_version: "6.12.0-211.69.1.el10_2", is_security: true, severity: "critical", advisory_id: "ALSA-2026:12345", cve_ids: [`${CVE}1`], repository: "appstream-long-repository-name" })),
  "/api/patching": IDS.map((i) => ({ id: `pa${i}`, host_id: `h${i}`, package_name: "kernel-modules-extra-matched-long-package-name", installed_version: "6.12.0-1.el10", fixed_version: "6.12.0-211.69.1.el10_2", is_security: true, severity: "critical", advisory_id: "ALSA-2026:12345", cve_ids: [`${CVE}1`], repository: "appstream-long-repository-name" })),
  "/api/patching/reports": { total: 24, items: IDS.map(job) },
  "/api/ai/budget": { limit_usd: 10, warning_usd: 8, billed_usd: 4.25, reserved_usd: 0.5, remaining_usd: 5.25, reset_at: now, week_start: now, warning: false, exhausted: false },
  "/api/ai/agents": [agent("coordinator"), agent("linux", { status: "working", current_task: `Checking ${LONG}` }), agent("monitoring", { status: "error", error_message: "x".repeat(120) }), agent("nova", { personal: true }), agent("ext-coder", { runtime: "external" })],
  "/api/ai/providers": [{ id: "p1", slug: "a-provider", kind: "anthropic", display_name: "A provider with a long display name", base_url: "https://api.example.test/v1/long/path", default_model: "a-very-long-model-identifier-2026-11-01", has_key: true, enabled: true, updated_at: now }],
  "/api/ai/tasks": IDS.slice(0, 12).map(task),
  "/api/ai/actions": [1, 2, 3].map(action),
  "/api/ai/findings": IDS.slice(0, 8).map((i) => ({ id: `f${i}`, agent_id: "id-linux", task_id: "t1", host_id: "h1", severity: "high", title: `Disk almost full on ${LONG}`, description: "x".repeat(140), evidence: { path: "/var/lib/containers" }, created_at: now })),
  "/api/ai/usage": { days: 30, points: IDS.slice(0, 10).map((i) => ({ date: `2026-11-${String(i).padStart(2, "0")}`, provider_id: "p1", provider_slug: "a-provider", provider_name: "A provider", model: "a-very-long-model-identifier", input_tokens: 123456, output_tokens: 65432, calls: 12, cost_usd: 1.23 })) },
  "/api/ai/memory": { enabled: true, items: IDS.slice(0, 6).map((i) => ({ id: `m${i}`, agent_id: null, key: "a.very.long.memory.key.name.for.testing", content: "x".repeat(200), source_task_id: null, updated_at: now, category: "work", kind: "fact", created_at: now })) },
  "/api/ai/memory/organize": { items: [] },
  "/api/ai/nova/routines": { settings: { enabled: false }, memory_enabled: true, talk_room: false, timezone: "Europe/Berlin", max_routines: 10, routines: [], runs: [] },
  "/api/ai/history": { items: [], total: 0 },
  "/api/ai/collaboration/settings": { revision: 1, tools: ["hosts.list"], daily_charged_tokens: 1000, policy: { enabled: true, max_active_investigations: 2, max_tokens: 1000, max_daily_tokens: 5000, max_output_tokens: 500, max_model_calls: 10, max_messages: 20, max_help_requests: 2, max_depth: 2, max_participants: 4, max_seconds: 60, max_post_chars: 400, rules: ["Be brief"], agents: {} } },
  "/api/ai/collaboration/boards": [],
  "/api/settings/traffic": { revision: 1, enabled: true, sources: [{ id: "s1", label: "A reverse proxy log with a long label", host_id: "h1", kind: "npm", enabled: true, use_sudo: false, log_path: "/data/npm/logs/proxy-host-1_access.log", domain: "a-very-long-domain-name.example.test", application: "generic", auth_domains: [], container: "", interface: "", journal_unit: "", ssh_failures: false }], allowed_countries: ["NO"], trusted_dns: [], retention_days: 30, max_rows: 100000, notify_authentication: true },
  "/api/incidents": { total: 3, monitor: { checked_at: Date.now() / 1000, alertmanager: "ok" }, items: [1, 2, 3].map((i) => ({ id: `in${i}`, title: `Database is unreachable on ${LONG}`, severity: "critical", status: "open", category: "availability", created_at: now, updated_at: now, summary: "x".repeat(140), source_state: "firing", last_seen: now, observations: 12 })) },
  "/api/ai/memory/suggestions": { items: [] },
  "/api/ai/memory/duplicates": { items: [] },
  "/api/ai/imports": { memory_enabled: true, conversations: 0, analyzed: 0, pending_import_suggestions: 0, max_upload_mb: 20 },
  "/api/ai/nova/sources": { cloud_provider: false, sources: [] },
  "/api/traffic/history": { now: Date.now() / 1000, events: IDS.map(trafficEvent), destinations: {}, stats: { total: 123456, clients: 321, countries: 12, errors: 45, handshakes: 6 }, countries: [{ name: "Norway", count: 1234 }], domains: { "a-very-long-domain-name.example.test": 123 }, timeline: IDS.map((i) => ({ ts: Date.now() / 1000 - i * 60, count: i })), enabled: true, sources: [{ name: "npm", label: "A reverse proxy log with a long label", kind: "npm", last_success: Date.now() / 1000, error: null, files: 3 }], retention_days: 30, max_rows: 100000, oldest: Date.now() / 1000 - 3600, offset: 0, limit: 100 },
  "/api/traffic/live": { now: Date.now() / 1000, events: [], destinations: {} },
  "/api/traffic/security": { now: Date.now() / 1000, total: 0, unreviewed: 0, last_success: Date.now() / 1000, error: null, started_at: null, baseline_ready: true, notification_error: null, talk_enabled: false, auth_total: 0, auth_offset: 0, auth_started_at: null, auth_policy: { countries: ["NO"], dns_names: [], addresses: [], checked_at: null, error: null }, authentication: [], alerts: [], logins: [] },
  "/api/traffic/security/banner": { enabled: true, now: Date.now() / 1000, last_success: Date.now() / 1000, error: null, sources: [], alerts: [], observations: [] },
  "/api/mcp/settings": { tools: [], auto_approvable: [], enabled: true },
  "/api/mcp/grants": [], "/api/mcp/requests": [], "/api/mcp/clients": [], "/api/mcp/audit": [],
  "/api/mcp/agent-access": { service_enabled: true, rows: [{ agent_id: "a1", agent: "Monitoring Agent", agent_slug: "monitoring", user_id: "u1", username: "operator-with-a-long-name", status: "expired", enabled_tools: ["ops_health", "ops_list_alerts", "ops_query_logs"], granted_tools: [], missing_tools: ["ops_health", "ops_list_alerts", "ops_query_logs"], expires_at: null, expired_at: "2026-10-13T12:45:24Z" }] },
};

const byPattern: [RegExp, unknown][] = [
  [/^\/api\/hosts\/[^/]+$/, host(1)],
  [/^\/api\/jobs\/[^/]+$/, { ...job(1), events }],
  [/^\/api\/hosts\/[^/]+\/patch-scan/, { id: "ps", host_id: "h1", status: "completed", pending_count: 24, pending_security_count: 12, reboot_required: true, started_at: now, completed_at: now, created_at: now, patches: exact["/api/patches"] }],
  [/^\/api\/docker-hosts\/[^/]+$/, (exact["/api/docker-hosts"] as unknown[])[0]],
  [/^\/api\/docker-hosts\/[^/]+\/images/, IDS.slice(0, 8).map((i) => ({ id: `sha256:${"a".repeat(64)}`, repo_tags: [IMAGE], repo_digests: [], created: now, size_bytes: 1e9 + i, container_count: 2 }))],
  [/^\/api\/docker-hosts\/[^/]+\/networks/, [{ id: "n1", name: "a-long-docker-network-name", driver: "bridge", scope: "local", subnet: "203.0.113.0/24", gateway: "203.0.113.1", containers: [{ name: container(1).name, ipv4_address: "203.0.113.2", ipv6_address: null, mac_address: "02:42:ac:11:00:02" }] }]],
  [/^\/api\/docker-hosts\/[^/]+\/volumes/, [{ name: "a-very-long-volume-name-that-is-a-hash-".padEnd(70, "f"), driver: "local", mountpoint: "/var/lib/docker/volumes/very/long/mountpoint/path/_data", created: now }]],
  [/^\/api\/docker-hosts\/[^/]+\/events/, IDS.slice(0, 6).map(() => ({ hostname: LONG, event_type: "container", action: "restart", actor_id: "a".repeat(64), actor_attributes: { name: "c" }, occurred_at: now }))],
  [/^\/api\/stacks\/[^/]+$/, [{ id: "st1", hostname: LONG, name: "an-observability-stack-with-a-long-name", source: "ops-center", container_count: 8, running_count: 7, created_at: now, updated_at: now, last_deployed_at: now, managed: true }]],
];

export function fixtureFor(pathname: string): unknown {
  if (pathname in exact) return exact[pathname];
  for (const [pattern, value] of byPattern) if (pattern.test(pathname)) return value;
  return undefined;
}

/** Answers every API path with worst-case data. Paths without data fall through to the fixture server. */
export async function signInWithFullData(page: Page) {
  await page.addInitScript(() => (document.cookie = "ops_refresh=" + "pwa-test-only" + "; path=/"));
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/ai/agents/stream") return route.fulfill({ status: 204, body: "" });
    const data = route.request().method() === "GET" ? fixtureFor(pathname) : undefined;
    return data === undefined ? route.fallback() : route.fulfill({ json: data });
  });
}

export const ROUTES = ["/", "/servers", "/servers/h1", "/services", "/monitoring", "/monitoring/hosts/h1", "/monitoring/containers/nc1", "/traffic-map", "/alerts", "/incidents", "/cameras",
  "/patching", "/patching/reports", "/vulnerabilities", "/security-intelligence", "/automation", "/automation/playbooks", "/ai-agents", "/ai-agents/documentation", "/ai-agents/chat", "/ai-agents/memory",
  "/ai-agents/agents", "/ai-agents/developer", "/ai-traffic/map", "/ai-agents/nova", "/ai-agents/ops-floor", "/ai-agents/tasks", "/ai-agents/approvals", "/ai-agents/mcp-access", "/ai-agents/agent-logs", "/ai-agents/collaboration", "/containers", "/containers/all",
  "/registries", "/app-catalog", `/containers/${NAME}-1`, `/containers/${NAME}-1/stacks/a-stack`, `/containers/${NAME}-1/a-container`, "/logs", "/jobs", "/jobs/j1", "/cluster", "/vpn",
  "/settings", "/settings?tab=ai", "/settings?tab=collaboration", "/settings?tab=mcp", "/login", "/wallboard", "/cameras/wallboard", "/traffic-map/wallboard", "/mcp/consent"];
