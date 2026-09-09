export interface HealthResponse {
  status: "ok" | "degraded";
  app: string;
  version: string;
  components: Record<string, "ok" | "error">;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>("/api/health");
}

export interface TrafficEvent {
  id: string;
  ts: number;
  ip: string;
  lat: number | null;
  lon: number | null;
  city: string | null;
  country: string | null;
  domain: string;
  status: number | null;
  source: "edge-host" | "home";
  suspicious: boolean;
}

export interface TrafficDestPoint {
  lat: number;
  lon: number;
  city: string | null;
  country: string | null;
}

export interface LiveTrafficResponse {
  now: number;
  events: TrafficEvent[];
  destinations: Record<string, TrafficDestPoint>;
}

export interface OnboardingStep {
  step: string;
  status: "pending" | "running" | "ok" | "failed" | "blocked";
  detail: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface Host {
  id: string;
  hostname: string;
  fqdn: string | null;
  ip_address: string;
  // Overrides ip_address as the Prometheus scrape target when set - lets a
  // host's monitoring path diverge from its SSH/Ansible management path
  // (e.g. reachable for management over a public IP but scraped over a
  // WireGuard tunnel IP instead).
  monitoring_ip_address: string | null;
  ssh_port: number;
  ssh_user: string;
  credential_id: string | null;
  operating_system: string | null;
  os_version: string | null;
  environment: string;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  group_ids: string[];
  criticality: string;
  description: string | null;
  auto_patch: boolean;
  security_patch_policy: string;
  reboot_policy: string;
  patch_window: string | null;
  monitoring_enabled: boolean;
  log_collection_enabled: boolean;
  is_docker_host: boolean;
  ssh_host_fingerprint: string | null;
  reboot_required: boolean;
  date_added: string;
  last_seen: string | null;
  last_ansible_run: string | null;
  tags: string[];
  onboarding_steps: OnboardingStep[];
}

export interface HostGroupMember {
  id: string;
  hostname: string;
}

export interface HostGroup {
  id: string;
  name: string;
  description: string | null;
  cron_expression: string | null;
  patch_type: "security" | "all" | "pihole" | null;
  batch_size: number;
  schedule_enabled: boolean;
  last_triggered_at: string | null;
  hosts: HostGroupMember[];
}

export interface Credential {
  id: string;
  name: string;
  description: string | null;
  credential_type: string;
  ssh_user: string | null;
  public_key: string | null;
  public_key_fingerprint: string | null;
}

export interface MonitoringCheck {
  id: string;
  host_id: string;
  check_type: string;
  target: string;
  enabled: boolean;
  created_at: string;
}

export interface HostCreate {
  hostname: string;
  fqdn?: string | null;
  ip_address: string;
  monitoring_ip_address?: string | null;
  ssh_port: number;
  ssh_user: string;
  credential_id?: string | null;
  environment: string;
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  group_ids?: string[];
  criticality: string;
  description?: string | null;
  tags: string[];
  services_to_monitor: string[];
  auto_patch: boolean;
  security_patch_policy: string;
  reboot_policy: string;
  patch_window?: string | null;
  monitoring_enabled: boolean;
  log_collection_enabled: boolean;
  is_docker_host?: boolean;
}

export interface AnsibleEvent {
  sequence: number;
  event_type: string;
  host: string | null;
  task: string | null;
  message: string | null;
  created_at: string;
}

export interface AnsibleJob {
  id: string;
  user: string | null;
  playbook: string;
  target_description: string;
  limit: string | null;
  extra_vars: Record<string, unknown>;
  status: "queued" | "running" | "successful" | "failed" | "cancelled";
  started_at: string | null;
  finished_at: string | null;
  changed_hosts: number;
  successful_hosts: number;
  failed_hosts: number;
  unreachable_hosts: number;
  created_at: string;
  events: AnsibleEvent[];
}

export interface AlertmanagerAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  status: { state: string };
}

export type PatchReportSummary = Pick<AnsibleJob, "id" | "playbook" | "target_description" | "status" | "created_at" | "started_at" | "finished_at" | "successful_hosts" | "changed_hosts" | "failed_hosts" | "unreachable_hosts">;
export interface PatchReportHost {
  host: string;
  status: string;
  changed: number | null;
  failed: number | null;
  unreachable: number | null;
  last_task: string | null;
  message: string | null;
}
export interface PatchReportDetail { job: AnsibleJob; hosts: PatchReportHost[] }

export interface AlertsResponse {
  available: boolean;
  alerts: AlertmanagerAlert[];
}

export interface Patch {
  id: string;
  host_id: string;
  package_name: string;
  installed_version: string | null;
  fixed_version: string | null;
  is_security: boolean;
  severity: string;
  advisory_id: string | null;
  cve_ids: string[];
  repository: string | null;
}

export interface PatchScan {
  id: string;
  host_id: string;
  status: string;
  pending_count: number;
  pending_security_count: number;
  reboot_required: boolean;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  patches: Patch[];
}

export interface AffectedHost {
  id: string;
  hostname: string;
  installed_version: string | null;
}

export interface AffectedContainer {
  name: string;
  hostname: string | null;
  image: string | null;
  installed_version: string | null;
}

export interface Vulnerability {
  id: string;
  cve_id: string;
  package_name: string;
  severity: string;
  cvss_score: number | null;
  fixed_version: string | null;
  fix_available: boolean;
  source: string;
  cisa_kev: boolean;
  epss_score: number | null;
  first_seen: string;
  last_seen: string;
  affected_hosts: AffectedHost[];
  affected_containers: AffectedContainer[];
  priority_level: string;
  priority_score: number;
}

export interface SourceStatus {
  name: string;
  status: string;
  last_success_at: string | null;
  last_error: string | null;
  records_last_run: number | null;
}

export interface SecurityAdvisory {
  id: string;
  source: string;
  advisory_id: string;
  title: string | null;
  severity: string;
  published_at: string | null;
  cve_ids: string[];
  packages: string[];
  url: string | null;
  affected_hosts: AffectedHost[];
}

export interface SecuritySummary {
  total_vulnerabilities: number;
  critical: number;
  high: number;
  kev: number;
  fix_available: number;
  affected_hosts: number;
  affected_containers: number;
  new_critical_advisories: number;
  new_kev_entries: number;
  sources: SourceStatus[];
}

export interface ContainerInfo {
  id: string;
  hostname: string;
  name: string;
  image: string;
  status: string;
  health: string | null;
  restart_count: number;
  last_seen: string;
  vulnerability_count: number;
  critical_vulnerability_count: number;
}

export interface DockerHost {
  hostname: string;
  ip_address: string;
  environment: string;
  container_count: number;
  running_count: number;
  stopped_count: number;
  unhealthy_count: number;
  last_seen: string | null;
}

export interface ImageInfo {
  id: string;
  repo_tags: string[];
  repo_digests: string[];
  created: string | null;
  size_bytes: number;
  container_count: number;
}

export interface DockerEventInfo {
  hostname: string;
  event_type: string;
  action: string;
  actor_id: string | null;
  actor_attributes: Record<string, string>;
  occurred_at: string;
}

export interface NetworkContainerInfo {
  name: string;
  ipv4_address: string | null;
  ipv6_address: string | null;
  mac_address: string | null;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  subnet: string | null;
  gateway: string | null;
  containers: NetworkContainerInfo[];
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  created: string | null;
}

export interface ContainerStats {
  cpu_percent: string | null;
  mem_usage: string | null;
  mem_percent: string | null;
  net_io: string | null;
  block_io: string | null;
  pids: string | null;
}

export interface ContainerLogs {
  lines: string[];
  ok: boolean;
}

export interface BulkActionItemResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface BulkActionResult {
  results: BulkActionItemResult[];
}

export interface StackSummary {
  id: string;
  hostname: string;
  name: string;
  source: string;
  container_count: number;
  running_count: number;
  created_at: string;
  updated_at: string;
  last_deployed_at: string | null;
  // False for a docker-compose project discovered on the host (Portainer,
  // or deployed by hand) that was never deployed through Ops Center.
  managed: boolean;
}

export interface StackContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  health: string | null;
}

export interface StackActionResultInfo {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ImageUpdateStatus {
  status: "up_to_date" | "update_available" | "unknown";
  local_digest: string | null;
  latest_digest: string | null;
  detail: string | null;
}

export interface ContainerVulnerabilityInfo {
  cve_id: string;
  severity: string;
  cvss_score: number | null;
  package_name: string;
  installed_version: string | null;
  fixed_version: string | null;
  fix_available: boolean;
  description: string | null;
}

export interface Registry {
  id: string;
  name: string;
  url: string;
  username: string | null;
  auth_required: boolean;
  description: string | null;
  created_at: string;
}

export interface RegistryCreate {
  name: string;
  url: string;
  username?: string | null;
  secret_filename?: string | null;
  auth_required: boolean;
  description?: string | null;
}

export interface AppTemplateEnvField {
  name: string;
  label: string;
  description: string | null;
  default: string | null;
  select: { text: string; value: string }[] | null;
}

export interface AppTemplate {
  id: number;
  type: number;
  title: string;
  description: string;
  categories: string[];
  logo: string | null;
  note: string | null;
  platform: string | null;
  env: AppTemplateEnvField[];
}

export interface AppCatalogSettings {
  template_url: string;
}

export interface RenderedTemplate {
  compose_yaml: string;
  suggested_name: string;
}

export interface MetricSeries {
  instance: string;
  points: [number, number][];
}

export interface HostMetricsResponse {
  available: boolean;
  cpu: MetricSeries[];
  memory: MetricSeries[];
  disk: MetricSeries[];
  network_rx: MetricSeries[];
  network_tx: MetricSeries[];
}

export interface ServiceStatus {
  service: string;
  up: boolean;
  latency_ms: number | null;
}

export interface LogLine {
  timestamp: string;
  labels: Record<string, string>;
  line: string;
}

export interface LogsResponse {
  available: boolean;
  lines: LogLine[];
}

export interface AutomationRunRequest {
  playbook: string;
  target_type: "host" | "hosts" | "group";
  host_id?: string;
  host_ids?: string[];
  group_id?: string;
  limit?: string;
  batch_size?: number;
  services?: string[];
  required_services?: string[];
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "ops_center_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Set by the auth context on mount so a 401 anywhere in the app can force a
// logout/redirect without every call site handling it individually.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

// Set by ToastProvider on mount, same pattern as onUnauthorized above: a
// central place to surface a failed mutation instead of every Delete/Retry/
// Scan/Save handler across the app needing its own try/catch + banner (most
// didn't have one - failures were silently swallowed and the UI looked like
// the action had succeeded). Deliberately wired into apiSend only, not
// apiGet - apiGet also backs ~15 background polling loops, and toasting
// every failed poll during a transient outage would replace silence with
// spam. A failed mutation is a single, user-initiated action; a toast is
// the right amount of feedback for exactly that.
let onApiError: ((message: string) => void) | null = null;
export function setApiErrorHandler(handler: ((message: string) => void) | null): void {
  onApiError = handler;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnauthorized(res: Response): void {
  if (res.status === 401) onUnauthorized?.();
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    handleUnauthorized(res);
    throw new ApiError(await safeDetail(res), res.status);
  }
  return res.json();
}

async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    handleUnauthorized(res);
    const detail = await safeDetail(res);
    if (res.status !== 401) onApiError?.(detail);
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function safeDetail(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
  } catch {
    return `HTTP ${res.status}`;
  }
}

export type Role = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  role: Role;
  username: string;
}

export interface AuditLogEntry {
  id: string;
  user: string | null;
  source_ip: string | null;
  action: string;
  target: string;
  parameters: Record<string, unknown>;
  result: string;
  created_at: string;
}

export interface PatroniNodeStatus {
  name: string | null;
  host: string;
  reachable: boolean;
  role: "primary" | "replica" | null;
  state: string | null;
  replication_state: string | null;
  timeline: number | null;
  replicas: Record<string, unknown>[] | null;
}

export interface PostgresStatus {
  scope: string;
  vip: string;
  vip_holder: string | null;
  nodes: PatroniNodeStatus[];
}

export interface RedisNodeStatus {
  host: string;
  reachable: boolean;
  role: "master" | "slave" | null;
  connected_slaves: number | null;
}

export interface SentinelView {
  host: string;
  reachable: boolean;
  master_host: string | null;
}

export interface RedisStatus {
  master_name: string;
  nodes: RedisNodeStatus[];
  sentinels: SentinelView[];
}

export interface ClusterStatus {
  postgres: PostgresStatus;
  redis: RedisStatus;
}

export interface CameraStatus {
  name: string;
  ip: string;
  kind: "tapo" | "ring";
  reachable: boolean;
  consecutive_fails: number;
  cooldown_remaining_seconds: number | null;
  last_kick_at: string | null;
  last_kick_result: "kicked" | "not_found" | "error" | null;
  has_stream: boolean;
}

export interface VpnPeer {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  latest_handshake_at: string | null;
  transfer_rx: number;
  transfer_tx: number;
  note: string | null;
}

export interface PersonalMemory { id: string; agent_id: string | null; key: string; content: string; source_task_id: string | null; updated_at: string }
export interface AIHistory { total: number; items: { agent: string; task: AITask }[] }

export interface AIProvider {
  id: string;
  slug: string;
  kind: "anthropic" | "openai" | "ollama";
  display_name: string;
  base_url: string | null;
  default_model: string | null;
  has_key: boolean;
  enabled: boolean;
  updated_at: string;
}

export interface AIUsagePoint {
  date: string;
  provider_id: string | null;
  provider_slug: string;
  provider_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  /** Estimated from a list-price table; null for models the table doesn't know. */
  cost_usd: number | null;
}

export interface AIUsageResponse {
  days: number;
  points: AIUsagePoint[];
}

export type AgentStatus = "idle" | "working" | "waiting" | "investigating" | "error" | "disabled";

export interface AIAgent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  responsibility: string | null;
  status: AgentStatus;
  current_task: string | null;
  error_message: string | null;
  provider_id: string | null;
  model: string | null;
  system_prompt: string;
  allowed_tools: string[];
  allowed_hosts: string[];
  allowed_environments: string[];
  autonomy_level: number;
  max_tool_calls: number;
  max_execution_seconds: number;
  enabled: boolean;
  last_activity_at: string | null;
  updated_at: string;
}

export interface AITask {
  id: string;
  agent_id: string;
  requested_by: string | null;
  source: string;
  conversation_key: string | null;
  input_message: string;
  response_message: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error_message: string | null;
  agents_used: string[];
  tools_used: { tool: string; arguments: Record<string, unknown> }[];
  data_sources: string[];
  confidence: number | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AIFinding {
  id: string;
  agent_id: string;
  task_id: string | null;
  host_id: string | null;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string | null;
  evidence: Record<string, unknown>;
  created_at: string;
}

export type ActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface AIAction {
  id: string;
  request_code: string;
  agent_id: string;
  task_id: string | null;
  host_id: string | null;
  action: string;
  tool: string;
  arguments: Record<string, unknown>;
  approval_level: number;
  risk: "low" | "medium" | "high";
  reason: string | null;
  status: ActionStatus;
  source: string;
  requested_by: string | null;
  approved_by: string | null;
  result: Record<string, unknown> | null;
  requested_at: string;
  expires_at: string | null;
  approved_at: string | null;
  executed_at: string | null;
}

export const api = {
  auth: {
    login: (username: string, password: string): Promise<LoginResponse> =>
      apiSend("/api/auth/login", "POST", { username, password }),
    me: (): Promise<User> => apiGet("/api/auth/me"),
  },
  users: {
    list: (): Promise<User[]> => apiGet("/api/users"),
    create: (payload: { username: string; password: string; role: Role }): Promise<User> =>
      apiSend("/api/users", "POST", payload),
    update: (id: string, payload: Partial<{ role: Role; is_active: boolean; password: string }>): Promise<User> =>
      apiSend(`/api/users/${id}`, "PATCH", payload),
    remove: (id: string): Promise<void> => apiSend(`/api/users/${id}`, "DELETE"),
  },
  audit: {
    list: (limit = 200): Promise<AuditLogEntry[]> => apiGet(`/api/audit?limit=${limit}`),
  },
  cluster: {
    status: (): Promise<ClusterStatus> => apiGet("/api/cluster/status"),
    switchover: (candidate?: string): Promise<{ ok: boolean; message: string }> =>
      apiSend("/api/cluster/postgres/switchover", "POST", candidate ? { candidate } : {}),
  },
  cameras: {
    status: (): Promise<CameraStatus[]> => apiGet("/api/cameras/status"),
  },
  vpn: {
    list: (): Promise<VpnPeer[]> => apiGet("/api/vpn/peers"),
    create: (name: string): Promise<VpnPeer> => apiSend("/api/vpn/peers", "POST", { name }),
    remove: (id: string): Promise<void> => apiSend(`/api/vpn/peers/${encodeURIComponent(id)}`, "DELETE"),
  },
  hosts: {
    list: (): Promise<Host[]> => apiGet("/api/hosts"),
    get: (id: string): Promise<Host> => apiGet(`/api/hosts/${id}`),
    create: (payload: HostCreate): Promise<Host> => apiSend("/api/hosts", "POST", payload),
    update: (id: string, payload: Partial<HostCreate>): Promise<Host> =>
      apiSend(`/api/hosts/${id}`, "PATCH", payload),
    remove: (id: string): Promise<void> => apiSend(`/api/hosts/${id}`, "DELETE"),
    verify: (id: string): Promise<Host> => apiSend(`/api/hosts/${id}/verify`, "POST"),
    scan: (id: string): Promise<{ job_id: string }> => apiSend(`/api/hosts/${id}/scan`, "POST"),
  },
  hostGroups: {
    list: (): Promise<HostGroup[]> => apiGet("/api/host-groups"),
    create: (payload: {
      name: string;
      description?: string | null;
      cron_expression?: string | null;
      patch_type?: "security" | "all" | "pihole" | null;
      batch_size?: number;
      schedule_enabled?: boolean;
    }): Promise<HostGroup> => apiSend("/api/host-groups", "POST", payload),
    update: (
      id: string,
      payload: Partial<{
        name: string;
        description: string | null;
        cron_expression: string | null;
        patch_type: "security" | "all" | "pihole" | null;
        batch_size: number;
        schedule_enabled: boolean;
      }>,
    ): Promise<HostGroup> => apiSend(`/api/host-groups/${id}`, "PATCH", payload),
    remove: (id: string): Promise<void> => apiSend(`/api/host-groups/${id}`, "DELETE"),
    addHost: (groupId: string, hostId: string): Promise<HostGroup> =>
      apiSend(`/api/host-groups/${groupId}/hosts/${hostId}`, "POST"),
    removeHost: (groupId: string, hostId: string): Promise<HostGroup> =>
      apiSend(`/api/host-groups/${groupId}/hosts/${hostId}`, "DELETE"),
    runNow: (groupId: string): Promise<AnsibleJob> => apiSend(`/api/host-groups/${groupId}/run-now`, "POST"),
  },
  credentials: {
    list: (): Promise<Credential[]> => apiGet("/api/credentials"),
    create: (payload: {
      name: string;
      description?: string | null;
      credential_type: string;
      ssh_user?: string | null;
      secret_filename: string;
      public_key?: string | null;
    }): Promise<Credential> => apiSend("/api/credentials", "POST", payload),
    remove: (id: string): Promise<void> => apiSend(`/api/credentials/${id}`, "DELETE"),
  },
  automation: {
    playbooks: (): Promise<string[]> => apiGet("/api/automation/playbooks"),
    run: (payload: AutomationRunRequest): Promise<AnsibleJob> => apiSend("/api/automation/run", "POST", payload),
  },
  ansible: {
    list: (): Promise<string[]> => apiGet("/api/ansible/playbooks"),
    get: (name: string): Promise<{ name: string; content: string }> =>
      apiGet(`/api/ansible/playbooks/${encodeURIComponent(name)}`),
    update: (name: string, content: string): Promise<{ name: string; content: string }> =>
      apiSend(`/api/ansible/playbooks/${encodeURIComponent(name)}`, "PUT", { content }),
  },
  alerts: {
    list: (): Promise<AlertsResponse> => apiGet("/api/alerts"),
  },
  services: {
    list: (): Promise<MonitoringCheck[]> => apiGet("/api/services"),
  },
  security: {
    vulnerabilities: (params?: {
      severity?: string;
      kev_only?: boolean;
      fix_available?: boolean;
      host_id?: string;
      container_name?: string;
    }): Promise<Vulnerability[]> => {
      const qs = new URLSearchParams();
      if (params?.severity) qs.set("severity", params.severity);
      if (params?.kev_only) qs.set("kev_only", "true");
      if (params?.fix_available !== undefined) qs.set("fix_available", String(params.fix_available));
      if (params?.host_id) qs.set("host_id", params.host_id);
      if (params?.container_name) qs.set("container_name", params.container_name);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiGet(`/api/security/vulnerabilities${suffix}`);
    },
    summary: (): Promise<SecuritySummary> => apiGet("/api/security/summary"),
    attention: (limit = 20): Promise<Vulnerability[]> => apiGet(`/api/security/attention?limit=${limit}`),
    advisories: (params?: { kev_only?: boolean; severity?: string; affectedOnly?: boolean }): Promise<
      SecurityAdvisory[]
    > => {
      const qs = new URLSearchParams();
      if (params?.kev_only) qs.set("kev_only", "true");
      if (params?.severity) qs.set("severity", params.severity);
      if (params?.affectedOnly !== undefined) qs.set("affected_only", String(params.affectedOnly));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiGet(`/api/security/advisories${suffix}`);
    },
    patchVulnerability: (vulnerabilityId: string): Promise<AnsibleJob> =>
      apiSend(`/api/security/vulnerabilities/${vulnerabilityId}/patch-security`, "POST"),
    patchAdvisory: (advisoryId: string): Promise<AnsibleJob> =>
      apiSend(`/api/security/advisories/${advisoryId}/patch-security`, "POST"),
  },
  containers: {
    list: (hostname?: string): Promise<ContainerInfo[]> =>
      apiGet(hostname ? `/api/containers?hostname=${encodeURIComponent(hostname)}` : "/api/containers"),
    start: (hostname: string, name: string): Promise<{ ok: boolean; message: string }> =>
      apiSend(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/start`, "POST"),
    stop: (hostname: string, name: string): Promise<{ ok: boolean; message: string }> =>
      apiSend(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/stop`, "POST"),
    restart: (hostname: string, name: string): Promise<{ ok: boolean; message: string }> =>
      apiSend(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/restart`, "POST"),
    bulkAction: (
      hostname: string,
      names: string[],
      action: "start" | "stop" | "restart",
    ): Promise<BulkActionResult> =>
      apiSend(`/api/containers/${encodeURIComponent(hostname)}/bulk-action`, "POST", { names, action }),
    inspect: (hostname: string, name: string): Promise<Record<string, unknown>> =>
      apiGet(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/inspect`),
    logs: (hostname: string, name: string, tail = 200): Promise<ContainerLogs> =>
      apiGet(
        `/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/logs?tail=${tail}`,
      ),
    stats: (hostname: string, name: string): Promise<ContainerStats> =>
      apiGet(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/stats`),
    vulnerabilities: (hostname: string, name: string): Promise<ContainerVulnerabilityInfo[]> =>
      apiGet(`/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/vulnerabilities`),
    updateStatus: (image: string, localDigest?: string | null): Promise<ImageUpdateStatus> => {
      const qs = new URLSearchParams({ image });
      if (localDigest) qs.set("local_digest", localDigest);
      return apiGet(`/api/images/update-status?${qs.toString()}`);
    },
    recreate: (hostname: string, name: string, image: string): Promise<{ ok: boolean; message: string }> =>
      apiSend(
        `/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/recreate?image=${encodeURIComponent(image)}`,
        "POST",
      ),
  },
  stacks: {
    list: (hostname: string): Promise<StackSummary[]> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/stacks`),
    get: (hostname: string, name: string): Promise<{ name: string; compose_yaml: string; path: string | null }> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(name)}`),
    containers: (hostname: string, name: string): Promise<StackContainer[]> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(name)}/containers`),
    deploy: (hostname: string, name: string, compose_yaml: string): Promise<StackActionResultInfo> =>
      apiSend(`/api/docker-hosts/${encodeURIComponent(hostname)}/stacks`, "POST", { name, compose_yaml }),
    remove: (hostname: string, name: string): Promise<StackActionResultInfo> =>
      apiSend(`/api/docker-hosts/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(name)}`, "DELETE"),
    action: (
      hostname: string,
      name: string,
      action: "start" | "stop" | "restart" | "pull",
    ): Promise<StackActionResultInfo> =>
      apiSend(
        `/api/docker-hosts/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(name)}/${action}`,
        "POST",
      ),
    adoptPreview: (hostname: string, name: string): Promise<RenderedTemplate> =>
      apiGet(
        `/api/docker-hosts/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(name)}/adopt-preview`,
      ),
  },
  registries: {
    list: (): Promise<Registry[]> => apiGet("/api/registries"),
    create: (payload: RegistryCreate): Promise<Registry> => apiSend("/api/registries", "POST", payload),
    remove: (id: string): Promise<void> => apiSend(`/api/registries/${id}`, "DELETE"),
  },
  appCatalog: {
    templates: (): Promise<AppTemplate[]> => apiGet("/api/app-catalog/templates"),
    settings: (): Promise<AppCatalogSettings> => apiGet("/api/app-catalog/settings"),
    updateSettings: (template_url: string): Promise<AppCatalogSettings> =>
      apiSend("/api/app-catalog/settings", "PUT", { template_url }),
    render: (templateId: number, env: Record<string, string>): Promise<RenderedTemplate> =>
      apiSend(`/api/app-catalog/templates/${templateId}/render`, "POST", { env }),
  },
  dockerHosts: {
    list: (): Promise<DockerHost[]> => apiGet("/api/docker-hosts"),
    get: (hostname: string): Promise<DockerHost> => apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}`),
    images: (hostname: string): Promise<ImageInfo[]> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/images`),
    networks: (hostname: string): Promise<NetworkInfo[]> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/networks`),
    volumes: (hostname: string): Promise<VolumeInfo[]> =>
      apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/volumes`),
    pullImage: (hostname: string, image: string): Promise<StackActionResultInfo> =>
      apiSend(
        `/api/docker-hosts/${encodeURIComponent(hostname)}/images/pull?image=${encodeURIComponent(image)}`,
        "POST",
      ),
    events: (hostname: string, eventType?: string): Promise<DockerEventInfo[]> => {
      const qs = new URLSearchParams();
      if (eventType) qs.set("event_type", eventType);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiGet(`/api/docker-hosts/${encodeURIComponent(hostname)}/events${suffix}`);
    },
  },
  logs: {
    query: (params: { host?: string; service?: string; minutes?: number }): Promise<LogsResponse> => {
      const qs = new URLSearchParams();
      if (params.host) qs.set("host", params.host);
      if (params.service) qs.set("service", params.service);
      if (params.minutes) qs.set("minutes", String(params.minutes));
      return apiGet(`/api/logs?${qs.toString()}`);
    },
  },
  metrics: {
    hosts: (minutes = 60, instance?: string): Promise<HostMetricsResponse> => {
      const qs = new URLSearchParams({ minutes: String(minutes) });
      if (instance) qs.set("instance", instance);
      return apiGet(`/api/metrics/hosts?${qs.toString()}`);
    },
    services: (): Promise<{ available: boolean; services: ServiceStatus[] }> => apiGet("/api/metrics/services"),
  },
  traffic: {
    live: (since = 0): Promise<LiveTrafficResponse> => apiGet(`/api/traffic/live?since=${since}`),
  },
  patching: {
    reports: (params: { status?: string; group?: string; offset?: number } = {}): Promise<{ total: number; items: PatchReportSummary[] }> => {
      const qs = new URLSearchParams({ offset: String(params.offset ?? 0) });
      if (params.status) qs.set("status", params.status);
      if (params.group) qs.set("group", params.group);
      return apiGet(`/api/patching/reports?${qs}`);
    },
    report: (id: string): Promise<PatchReportDetail> => apiGet(`/api/patching/reports/${encodeURIComponent(id)}`),
    list: (params?: { severity?: string; securityOnly?: boolean }): Promise<Patch[]> => {
      const qs = new URLSearchParams();
      if (params?.severity) qs.set("severity", params.severity);
      if (params?.securityOnly) qs.set("security_only", "true");
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiGet(`/api/patches${suffix}`);
    },
    hostScan: (hostId: string): Promise<PatchScan | null> => apiGet(`/api/hosts/${hostId}/patches`),
    check: (hostId: string): Promise<AnsibleJob> => apiSend(`/api/hosts/${hostId}/patch-check`, "POST"),
    installSecurity: (hostId: string): Promise<AnsibleJob> =>
      apiSend(`/api/hosts/${hostId}/patch-security`, "POST"),
    installAll: (hostId: string): Promise<AnsibleJob> => apiSend(`/api/hosts/${hostId}/patch-all`, "POST"),
  },
  jobs: {
    list: (status?: string): Promise<AnsibleJob[]> =>
      apiGet(`/api/jobs${status ? `?status=${status}` : ""}`),
    get: (id: string): Promise<AnsibleJob> => apiGet(`/api/jobs/${id}`),
    cancel: (id: string): Promise<AnsibleJob> => apiSend(`/api/jobs/${id}/cancel`, "POST"),
  },
  ai: {
    memory: {
      list: (): Promise<{ enabled: boolean; items: PersonalMemory[] }> => apiGet("/api/ai/memory"),
      save: (key: string, content: string, agentId: string | null = null): Promise<{ ok: boolean }> => apiSend("/api/ai/memory", "PUT", { key, content, agent_id: agentId }),
      remove: (id: string): Promise<void> => apiSend(`/api/ai/memory/${encodeURIComponent(id)}`, "DELETE"),
      preference: (enabled: boolean): Promise<{ enabled: boolean }> => apiSend("/api/ai/memory/preferences", "PUT", { enabled }),
    },
    history: (params: { agent?: string; conversation_key?: string; q?: string; offset?: number; limit?: number } = {}): Promise<AIHistory> => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
      return apiGet(`/api/ai/history?${query}`);
    },
    providers: {
      list: (): Promise<AIProvider[]> => apiGet("/api/ai/providers"),
      create: (payload: { slug: string; kind: string; display_name: string; base_url?: string; default_model?: string }): Promise<AIProvider> =>
        apiSend("/api/ai/providers", "POST", payload),
      update: (id: string, payload: Partial<{ display_name: string; base_url: string; default_model: string; enabled: boolean }>): Promise<AIProvider> =>
        apiSend(`/api/ai/providers/${id}`, "PATCH", payload),
      setKey: (id: string, apiKey: string): Promise<AIProvider> =>
        apiSend(`/api/ai/providers/${id}/key`, "POST", { api_key: apiKey }),
      clearKey: (id: string): Promise<AIProvider> => apiSend(`/api/ai/providers/${id}/key`, "DELETE"),
    },
    agents: {
      list: (): Promise<AIAgent[]> => apiGet("/api/ai/agents"),
      get: (id: string): Promise<AIAgent> => apiGet(`/api/ai/agents/${id}`),
      create: (payload: {
        slug: string;
        name: string;
        description?: string;
        responsibility?: string;
        provider_id?: string | null;
        model?: string | null;
        system_prompt?: string;
        allowed_tools?: string[];
        allowed_hosts?: string[];
        allowed_environments?: string[];
        autonomy_level?: number;
        max_tool_calls?: number;
        max_execution_seconds?: number;
        enabled?: boolean;
      }): Promise<AIAgent> => apiSend("/api/ai/agents", "POST", payload),
      update: (id: string, payload: Partial<AIAgent>): Promise<AIAgent> =>
        apiSend(`/api/ai/agents/${id}`, "PATCH", payload),
      remove: (id: string): Promise<void> => apiSend(`/api/ai/agents/${id}`, "DELETE"),
    },
    ask: (message: string, agent = "coordinator", conversationKey?: string): Promise<AITask> =>
      apiSend("/api/ai/ask", "POST", { message, agent, conversation_key: conversationKey }),
    usage: (days = 7): Promise<AIUsageResponse> => apiGet(`/api/ai/usage?days=${days}`),
    tasks: {
      cancel: (id: string): Promise<AITask> => apiSend(`/api/ai/tasks/${id}/cancel`, "POST"),
      list: (limit = 50): Promise<AITask[]> => apiGet(`/api/ai/tasks?limit=${limit}`),
      get: (id: string): Promise<AITask> => apiGet(`/api/ai/tasks/${id}`),
    },
    findings: {
      list: (limit = 50): Promise<AIFinding[]> => apiGet(`/api/ai/findings?limit=${limit}`),
    },
    actions: {
      list: (status?: string, limit = 50, taskId?: string): Promise<AIAction[]> =>
        apiGet(
          `/api/ai/actions?limit=${limit}${status ? `&status=${status}` : ""}${taskId ? `&task_id=${taskId}` : ""}`,
        ),
      approve: (id: string): Promise<AIAction> => apiSend(`/api/ai/actions/${id}/approve`, "POST"),
      reject: (id: string): Promise<AIAction> => apiSend(`/api/ai/actions/${id}/reject`, "POST"),
    },
  },
};
