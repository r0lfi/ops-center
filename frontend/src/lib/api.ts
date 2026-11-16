import type { NativeFleet, NativeContainer } from "@/lib/monitoring";
import type { AuthenticationBannerData } from "@/components/traffic/AuthenticationBanner";
import type { SecurityData } from "@/components/traffic/SecuritySignals";
export interface AIWeeklyBudget {
  limit_usd: number; warning_usd: number; billed_usd: number; reserved_usd: number; remaining_usd: number;
  reset_at: string; week_start: string; warning: boolean; exhausted: boolean; pricing_unknown?: number;
}
export interface CollaborationPermissions {
  read: boolean; post: boolean; ask: boolean; respond: boolean; peers: string[]; tools: string[];
}
export interface CollaborationPolicy {
  enabled: boolean; max_active_investigations: number; max_tokens: number; max_daily_tokens: number; max_output_tokens: number;
  max_model_calls: number; max_messages: number; max_help_requests: number; max_depth: number;
  max_participants: number; max_seconds: number; max_post_chars: number;
  rules: string[]; agents: Record<string, CollaborationPermissions>;
}
export interface CollaborationSettings {
  revision: number; policy: CollaborationPolicy; tools: string[]; daily_charged_tokens: number;
}
export interface CollaborationBoard {
  task_id: string; status: string; stop_reason: string | null; participants: string[];
  charged_tokens: number; actual_tokens: number; model_calls: number; message_count: number;
  created_at: string; expires_at: string; policy: CollaborationPolicy;
  scope_snapshot?: Record<string, unknown> | null;
}
export interface CollaborationSummary {
  board: CollaborationBoard; question: string; task_status: string;
  lead_agent?: string | null;
  task_started_at?: string | null;
  task_completed_at?: string | null;
}
export interface CollaborationPost {
  id: string; sequence: number; agent: string; recipient: string | null; kind: string;
  content: string; created_at: string; reply_to_id?: string | null;
}
export interface CollaborationDetail extends CollaborationSummary {
  posts: CollaborationPost[];
  tool_executions?: AITask["tools_used"];
  data_sources?: string[];
  confidence?: number | null;
  response_message?: string | null;
}
export interface CollaborationExperiences {
  memory_enabled: boolean;
  items: { id: string; task_id: string; agent: string; content: string; created_at: string; question: string }[];
}

export interface HealthResponse {
  status: "ok" | "degraded";
  app: string;
  version: string;
  components: Record<string, "ok" | "error">;
}

export const HEALTH_COMPONENT_LABELS: Record<string, string> = {
  database: "Database",
  redis: "Redis",
  loki: "Loki",
  security_feeds: "Security feeds",
  prometheus: "Prometheus",
  alertmanager: "Alertmanager",
  grafana: "Grafana",
};

export async function fetchHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>("/api/health");
}

export interface TrafficSourceConfig {
  id: string; label: string; host_id: string;
  kind: "npm" | "caddy" | "ssh" | "auth_audit" | "wireguard";
  enabled: boolean; use_sudo: boolean; log_path: string; domain: string;
  application: "generic" | "jellyfin" | "wg_easy"; auth_domains: string[];
  container: string; interface: string; journal_unit: string; ssh_failures: boolean;
}
export interface TrafficSettingsConfig {
  revision: number; enabled: boolean; sources: TrafficSourceConfig[];
  allowed_countries: string[]; trusted_dns: string[]; trusted_ips?: string[];
  retention_days: number; max_rows: number; notify_authentication: boolean;
}

export interface TrafficEvent {
  signal?: "auth_success" | "auth_failure" | "auth_throttled" | "auth_attempt" | "probe" | null;
  kind: "http" | "wireguard" | "ssh" | "auth";
  id: string;
  ts: number;
  ip: string;
  lat: number | null;
  lon: number | null;
  city: string | null;
  country: string | null;
  domain: string;
  status: number | null;
  source: string;
  suspicious: boolean;
}


export interface TrafficHistory {
  now: number; events: TrafficEvent[]; destinations: Record<string,TrafficDestPoint>;
  stats: {total:number;clients:number;countries:number;errors:number;handshakes:number;http?:number;ssh?:number};
  countries: {name:string;count:number}[]; domains: Record<string,number>;
  timeline: {ts:number;count:number}[];
  enabled?: boolean;
  sources: {name:string;label?:string;kind?:string;last_success:number|null;error:string|null;warning?:string|null;files:number}[];
  retention_days:number;max_rows:number;oldest:number|null;offset:number;limit:number;
}

export interface TrafficDestPoint {
  label?: string;
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
  packages?: { name: string; from: string; to: string }[]; reboot_required?: string | null;
  tasks?: { task: string; result: string }[]; output?: string | null;
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
  state?: string; message?: string | null; next_cursor?: string | null; source?: string; levels?: string[]; start?: number; end?: number;
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

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// The access token lives only in memory: it is never written to localStorage
// or sessionStorage. A page load gets a fresh one from the HttpOnly refresh
// cookie (/api/auth/refresh), which JavaScript cannot read.
let accessToken: string | null = null;
let accessExpires = 0;
try { localStorage.removeItem("ops_center_token"); } catch { /* Old builds kept the token here; remove it. */ }

/** Other tabs of this browser hear about logout/login at once. */
const sessionChannel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ops-session");
export function broadcastSession(event: "login" | "logout"): void { sessionChannel?.postMessage(event); }
export function onSessionBroadcast(handler: (event: string) => void): () => void {
  if (!sessionChannel) return () => {};
  const listener = (message: MessageEvent) => handler(String(message.data));
  sessionChannel.addEventListener("message", listener);
  return () => sessionChannel.removeEventListener("message", listener);
}

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  const changed = token !== accessToken;
  accessToken = token;
  accessExpires = 0;
  if (token) {
    try {
      const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      accessExpires = Number(JSON.parse(atob(encoded)).exp) * 1000;
    } catch { /* The backend still validates it. */ }
  }
  if (changed) window.dispatchEvent(new Event("ops-session-changed"));
}

const SESSION_HEADERS = { "X-Requested-With": "ops-center" };

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

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function handleUnauthorized(res: Response, token: string | null): void {
  // A late response from an old request must not discard a renewed/new session.
  if (res.status === 401 && token === getToken()) onUnauthorized?.();
}

let renewal: Promise<void> | null = null;

/**
 * Get a new access token from the refresh cookie when the current one is
 * missing or about to expire (or always, with force). The cookie rotates on
 * every use. A 401 means there is no valid session: with a token in memory
 * that ends the session in this tab; on startup it simply means "signed out".
 */
export async function renewSession(force = false): Promise<void> {
  const token = accessToken;
  // A token whose expiry cannot be read is left to the backend to validate (a 401 then ends it).
  if (!force && (!token || !accessExpires || accessExpires - Date.now() > 2 * 60 * 1000)) return;
  if (renewal) return renewal;
  const pending = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const res = await apiFetch("/api/auth/refresh", { method: "POST", headers: SESSION_HEADERS, credentials: "same-origin", signal: controller.signal });
      if (!res.ok) {
        if (token) handleUnauthorized(res, token);
        throw new ApiError(await safeDetail(res), res.status);
      }
      const data: LoginResponse = await res.json();
      if (!data.access_token) throw new Error("Session renewal returned no token");
      // A logout in this tab while the request was in flight wins.
      if (accessToken === token) setToken(data.access_token);
    } finally { clearTimeout(timeout); }
  })();
  renewal = pending;
  try { await pending; } finally { if (renewal === pending) renewal = null; }
}

/** End this browser's session on the server (the refresh cookie) and in memory. */
export async function endSession(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST", headers: SESSION_HEADERS, credentials: "same-origin" });
  } finally {
    setToken(null);
    broadcastSession("logout");
  }
}

/** True when the server wants the password confirmed again before this action. */
export function needsReauth(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.message === "reauthentication required";
}

// Preserve auth and command semantics; never queue or replay failed requests.
async function apiFetch(path: string, options: RequestInit): Promise<Response> {
  try {
    const response = await fetch(path, { ...options, cache: "no-store" });
    // Only gateway failures suggest the backend is gone; a 500 is an error in one endpoint.
    if ([502, 503, 504].includes(response.status)) window.dispatchEvent(new Event("ops-backend-unavailable"));
    return response;
  } catch (error) {
    window.dispatchEvent(new Event("ops-backend-unavailable"));
    throw error;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  await renewSession();
  const token = getToken();
  const res = await apiFetch(path, { headers: authHeaders(token) });
  if (!res.ok) {
    handleUnauthorized(res, token);
    throw new ApiError(await safeDetail(res), res.status);
  }
  return res.json();
}

export async function apiSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  if (path !== "/api/auth/login") await renewSession();
  const token = getToken();
  const res = await apiFetch(path, {
    method,
    headers: {
      ...authHeaders(token),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    handleUnauthorized(res, token);
    const detail = await safeDetail(res);
    // A wrong password or a pending re-authentication is shown by the form that asked.
    if (res.status !== 401 && detail !== "reauthentication required" && path !== "/api/auth/reauth") onApiError?.(detail);
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
  remember?: boolean;
}

export interface UserSessionInfo {
  id: string;
  user_id: string;
  username: string;
  remember: boolean;
  created_at: string;
  last_used_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  user_agent: string | null;
  ip: string | null;
  current: boolean;
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

export type MemoryKind = "fact" | "plan" | "history";
export interface PersonalMemory {
  id: string; agent_id: string | null; key: string; content: string; source_task_id: string | null; updated_at: string;
  category?: string | null; kind?: MemoryKind | null; created_at?: string;
}
export interface MemoryVersion {
  id: string; memory_id: string | null; agent_id: string | null; key: string; category: string | null; kind: MemoryKind | null;
  content: string; change: "update" | "scope" | "merge" | "delete" | "restore"; changed_by: string; created_at: string;
}
export interface OrganizeTarget { id: string; key: string; category: string | null; kind: MemoryKind; content: string; scope: "nova" | "shared" }
export interface OrganizeProposal {
  id: string; key: string; category: string | null; kind: MemoryKind; content: string; scope: "nova" | "shared";
  suggested_scope: "nova" | "shared"; action: "create" | "update" | "unchanged"; reason: string | null; target: OrganizeTarget | null; section: number;
}
export type RoutineChannel = "web" | "talk";
export interface NovaRoutine {
  id: string; name: string; schedule: string; instruction: string; channel: RoutineChannel; enabled: boolean;
  last_run_at: string | null; next_run_at: string | null; created_at: string;
}
export interface NovaRoutineRun {
  id: string; routine_id: string; routine_name: string; due_at: string; manual: boolean; channel: RoutineChannel;
  status: "started" | "skipped"; reason: string | null; task_id: string | null; task_status: AITask["status"] | null;
  response: string | null; error: string | null; completed_at: string | null; delivered_at: string | null; delivery_error: string | null;
}
export interface ProactiveSettings { enabled: boolean; quiet_start: string; quiet_end: string; max_per_day: number }
export interface NovaRoutines {
  settings: ProactiveSettings; memory_enabled: boolean; talk_room: boolean; timezone: string; max_routines: number;
  routines: NovaRoutine[]; runs: NovaRoutineRun[];
}
export interface NovaDataSource {
  kind: "caldav" | "homeassistant"; label: string; host: string | null; calendars: string[]; task_lists: string[]; entities: string[];
  allow_cloud: boolean; secret_present: boolean; offered: boolean; tools: string[];
}
export interface NovaDataSources { cloud_provider: boolean; sources: NovaDataSource[] }
export interface DataSourceTest { results: { kind: NovaDataSource["kind"]; ok: boolean; error: string | null }[] }
export type RoutineInput = Pick<NovaRoutine, "name" | "schedule" | "instruction" | "channel" | "enabled">;
export interface OrganizeSection { index: number; chars: number; status: "pending" | "done" | "failed"; error: string | null; secrets: number | null; dropped: number | null }
export interface OrganizeJob {
  id: string; status: "queued" | "running" | "done" | "partial" | "failed"; source_name: string; created_at: string; finished_at: string | null;
  sections: OrganizeSection[]; proposals: OrganizeProposal[] | null; proposal_count: number;
  estimate?: { sections: number; input_tokens: number; output_tokens: number; provider: string | null; local: boolean; cost_usd: number | null };
}
export interface OrganizeItem {
  action: "create" | "update" | "skip"; key: string; content: string; category: string | null; kind: MemoryKind | null;
  scope: "nova" | "shared"; target_id: string | null;
}
export class OrganizeApplyError extends Error {
  constructor(message: string, public errors: { index: number; key: string; error: string }[]) { super(message); }
}
export interface AIHistory { total: number; items: { agent: string; task: AITask }[] }
export type ImportSource = "chatgpt" | "claude" | "gemini" | "other";
export type ImportKind = "memory_list" | "chatgpt_export";
export interface ImportStatus { memory_enabled: boolean; conversations: number; analyzed: number; pending_import_suggestions: number; max_upload_mb: number }
export interface ImportSummary {
  kind: ImportKind; imported?: boolean; sample: string[];
  items?: number; new_suggestions?: number; already_suggested?: number; filtered_secrets?: number; duplicates?: number; skipped_short?: number;
  conversations?: number; new?: number; updated?: number; unchanged?: number; filtered_secret_lines?: number; skipped_empty?: number; ignored_files?: number;
}
export interface ImportEstimate { conversations: number; model_calls: number; input_tokens: number; output_tokens: number; provider: string | null; local: boolean; cost_usd: number | null; note: string | null }

async function uploadImport(path: string, kind: ImportKind, source: ImportSource, file: Blob, name: string): Promise<ImportSummary> {
  const form = new FormData();
  form.append("kind", kind);
  form.append("source", source);
  form.append("file", file, name);
  const res = await fetch(path, { method: "POST", body: form, headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) {
    let detail = "Upload failed";
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(typeof detail === "string" ? detail : "Upload failed");
  }
  return res.json();
}

export interface MemorySuggestion {
  id: string; agent_id: string | null; key: string; content: string; source: "conversation" | "import" | "journal";
  evidence_task_id: string | null; status: "pending" | "accepted" | "rejected"; created_at: string; decided_at: string | null;
  category?: string | null; kind?: MemoryKind | null; target_memory_id?: string | null; target?: PersonalMemory | null;
}

async function sendForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", body: form, headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return res.json();
}

async function applyOrganize(id: string, items: OrganizeItem[]): Promise<{ created: number; updated: number; skipped: number }> {
  const res = await fetch(`/api/ai/memory/organize/${encodeURIComponent(id)}/apply`, {
    method: "POST", body: JSON.stringify({ items }), headers: { Authorization: `Bearer ${getToken() ?? ""}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.detail;
    if (detail && typeof detail === "object" && Array.isArray(detail.errors)) throw new OrganizeApplyError(detail.message ?? "Nothing was saved.", detail.errors);
    throw new Error(typeof detail === "string" ? detail : "Saving failed");
  }
  return body;
}

export interface AIProvider {
  id: string;
  slug: string;
  kind: "anthropic" | "openai" | "mistral" | "ollama" | "openai_compatible";
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
  /** "external": runs outside Ops Center (e.g. opencode) and reports its own state. */
  runtime?: "native" | "external";
  /** Slugs this agent may delegate to; null = every enabled non-personal agent. */
  allowed_dispatch_targets?: string[] | null;
  /** Personal agents (nova) are never delegation targets and their tasks are owner-only. */
  personal?: boolean;
  last_activity_at: string | null;
  updated_at: string;
  /** Open tasks (GET /ai/agents); one agent with many tasks is still one agent. */
  running_tasks?: number;
  queued_tasks?: number;
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
  outcome?: AITaskOutcome | null;
  resumed_from?: string | null;
}

export type AITaskOutcome = "completed" | "inconclusive" | "blocked" | "waiting_for_approval" | "failed";
export type AIWorkItemStatus = "queued" | "running" | "waiting_for_agent" | "waiting_for_approval" | "blocked" | "completed" | "failed" | "inconclusive";

export interface AIWorkItem {
  id: string;
  agent: string;
  title: string;
  status: AIWorkItemStatus;
  depends_on: string[];
  result: string | null;
  tools: string[];
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
}

export interface AIBoardFinding {
  id: string;
  kind: "fact" | "hypothesis" | "ruled_out" | "resolution";
  system: string | null;
  statement: string;
  evidence: string | null;
  source: string | null;
  observed_at: string;
  stale: boolean;
}

export interface AIToolProposal {
  id: string;
  task_id: string | null;
  title: string;
  status: "proposed" | "in_development" | "ready_for_review" | "changes_requested" | "approved" | "deployed" | "rejected" | "release_failed" | "rolled_back";
  details: Record<string, string>;
  has_patch: boolean;
  patch_notes: string | null;
  dev_task_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export type DevStage = "proposed" | "working" | "ready_for_review" | "changes_requested" | "approved" | "in_production" | "rejected" | "failed" | "rolled_back";

export interface DevRun {
  id: string; status: AITask["status"]; outcome: string | null; requested_by: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; duration_ms: number | null;
  tools_used: number; error: string | null;
}

export interface DevChange {
  id: string; title: string; status: AIToolProposal["status"]; stage: DevStage; summary: string;
  proposed_by: string | null; developer_run: DevRun | null; runs: number;
  files: number; added: number; removed: number; has_patch: boolean; patch_sha256: string | null;
  approved_by: string | null; approved_at: string | null; release_ref: string | null; branch: string | null;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
}

export interface DevChangeDetail extends DevChange {
  details: Record<string, string>; notes: string | null; task_id: string | null; traffic_events: number;
  files_changed: { path: string; added: number; removed: number; status: "added" | "modified" | "deleted"; kind: "code" | "test" | "docs" | "config" }[];
  checks: { name: string; result: "passed" | "failed" | "warning" | "not_run"; detail: string }[];
  runs_detail: DevRun[];
  timeline: { at: string; kind: string; text: string }[];
  reviews: { decision: string; comment: string | null; patch_sha256: string | null; release_ref: string | null; decided_by: string; decided_at: string }[];
}

export interface DevOverview {
  agent: { name: string; status: string; activity: string | null; enabled: boolean; configured: boolean } | null;
  counts: Partial<Record<DevStage, number>>;
  items: DevChange[];
  can_decide: boolean;
}

export interface AITaskBoard {
  task_id: string;
  status: AITask["status"];
  outcome: AITaskOutcome | null;
  resumable: boolean;
  resumed_by: string | null;
  items: AIWorkItem[];
  findings: AIBoardFinding[];
  proposals: AIToolProposal[];
  actions: { id: string; code: string; tool: string; status: string; level: number; reason: string | null }[];
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
    login: (username: string, password: string, remember_me = false): Promise<LoginResponse> =>
      apiSend("/api/auth/login", "POST", { username, password, remember_me }),
    reauth: async (password: string): Promise<void> => {
      const res: LoginResponse = await apiSend("/api/auth/reauth", "POST", { password });
      setToken(res.access_token);
    },
    me: (): Promise<User> => apiGet("/api/auth/me"),
    sessions: (allUsers = false): Promise<UserSessionInfo[]> => apiGet(`/api/auth/sessions${allUsers ? "?all_users=true" : ""}`),
    revokeOwnSession: (id: string): Promise<void> => apiSend(`/api/auth/sessions/${id}`, "DELETE"),
    revokeSession: (userId: string, id: string): Promise<void> => apiSend(`/api/users/${userId}/sessions/${id}/revoke`, "POST"),
    revokeAllSessions: (userId: string): Promise<{ revoked: number }> => apiSend(`/api/users/${userId}/sessions/revoke-all`, "POST"),
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
      search?: string;
      limit?: number;
    }): Promise<Vulnerability[]> => {
      const qs = new URLSearchParams();
      if (params?.severity) qs.set("severity", params.severity);
      if (params?.kev_only) qs.set("kev_only", "true");
      if (params?.fix_available !== undefined) qs.set("fix_available", String(params.fix_available));
      if (params?.host_id) qs.set("host_id", params.host_id);
      if (params?.container_name) qs.set("container_name", params.container_name);
      if (params?.search) qs.set("search", params.search);
      if (params?.limit) qs.set("limit", String(params.limit));
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
  monitoring: {
    fleet: (minutes: number, end?: number, hostId?: string): Promise<NativeFleet> => {
      const qs = new URLSearchParams({minutes: String(minutes)});
      if (end !== undefined) qs.set("end", String(end));
      if (hostId) qs.set("host_id", hostId);
      return apiGet(`/api/monitoring/fleet?${qs}`);
    },
    container: (id: string, minutes: number, end?: number): Promise<NativeContainer> => {
      const qs = new URLSearchParams({minutes: String(minutes)});
      if (end !== undefined) qs.set("end", String(end));
      return apiGet(`/api/monitoring/containers/${encodeURIComponent(id)}?${qs}`);
    },
    stats: (id: string): Promise<Record<string, string | null>> => apiGet(`/api/monitoring/containers/${encodeURIComponent(id)}/stats`),
    events: (id: string, minutes: number, end?: number): Promise<{state:string; events:{action:string;occurred_at:string;actor_id:string}[]}> => {
      const qs = new URLSearchParams({minutes: String(minutes)});
      if (end !== undefined) qs.set("end", String(end));
      return apiGet(`/api/monitoring/containers/${encodeURIComponent(id)}/events?${qs}`);
    },
  },
  logs: {
    query: (params: { host?: string; host_id?: string; container_id?: string; service?: string; search?: string;
      level?: string; minutes?: number; limit?: number; end?: number; cursor?: string }): Promise<LogsResponse> => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") qs.set(key, String(value)); });
      return apiGet(`/api/logs?${qs}`);
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
    settings: (): Promise<TrafficSettingsConfig> => apiGet("/api/settings/traffic"),
    updateSettings: (config: TrafficSettingsConfig): Promise<TrafficSettingsConfig> => apiSend("/api/settings/traffic", "PUT", config),
    authenticationBanner: (): Promise<AuthenticationBannerData> => apiGet("/api/traffic/security/banner"),
    security: (service: string, hours: number, result = "all", offset = 0): Promise<SecurityData> => apiGet(`/api/traffic/security?service=${encodeURIComponent(service)}&hours=${hours}&auth_result=${encodeURIComponent(result)}&auth_offset=${offset}`),
    reviewSecurity: (id: number): Promise<{ok:boolean}> => apiSend(`/api/traffic/security/${id}/review`, "POST"),
    history: (params: {hours:number;service:string;errors:boolean;search:string;offset:number;until?:number}): Promise<TrafficHistory> => {
      const qs=new URLSearchParams();Object.entries(params).forEach(([k,v])=>{if(v!==undefined)qs.set(k,String(v))});return apiGet(`/api/traffic/history?${qs}`);
    },
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
    budget: (): Promise<AIWeeklyBudget> => apiGet("/api/ai/budget"),
    setBudgetLimit: (limit_usd: number): Promise<AIWeeklyBudget> => apiSend("/api/ai/budget", "PUT", { limit_usd }),
    collaboration: {
      settings: (): Promise<CollaborationSettings> => apiGet("/api/ai/collaboration/settings"),
      save: (revision: number, policy: CollaborationPolicy): Promise<CollaborationSettings> => apiSend("/api/ai/collaboration/settings", "PUT", { revision, policy }),
      experiences: (q = ""): Promise<CollaborationExperiences> => apiGet(`/api/ai/collaboration/experiences?${new URLSearchParams({ q, limit: "30" })}`),
      boards: (offset = 0): Promise<CollaborationSummary[]> => apiGet(`/api/ai/collaboration/boards?offset=${offset}`),
      board: (id: string): Promise<CollaborationDetail> => apiGet(`/api/ai/collaboration/boards/${id}`),
      stop: (id: string): Promise<CollaborationBoard> => apiSend(`/api/ai/collaboration/boards/${id}/stop`, "POST"),
      start: (message: string, agent: string): Promise<{ task_id: string }> => apiSend("/api/ai/collaboration/boards", "POST", { message, agent }),
    },

    memory: {
      list: (): Promise<{ enabled: boolean; items: PersonalMemory[] }> => apiGet("/api/ai/memory"),
      save: (key: string, content: string, agentId: string | null = null, extra: { category?: string | null; kind?: MemoryKind | null } = {}): Promise<{ ok: boolean }> =>
        apiSend("/api/ai/memory", "PUT", { key, content, agent_id: agentId, ...extra }),
      update: (id: string, edits: Partial<{ key: string; content: string; category: string | null; kind: MemoryKind | null; agent_id: string | null }>): Promise<PersonalMemory> =>
        apiSend(`/api/ai/memory/${encodeURIComponent(id)}`, "PATCH", edits),
      merge: (payload: { ids: string[]; key: string; content: string; category: string | null; kind: MemoryKind | null; agent_id: string | null }): Promise<PersonalMemory> =>
        apiSend("/api/ai/memory/merge", "POST", payload),
      duplicates: (): Promise<{ pairs: { a: string; b: string; score: number }[] }> => apiGet("/api/ai/memory/duplicates"),
      history: (params: { memoryId?: string; deleted?: boolean }): Promise<{ items: MemoryVersion[] }> =>
        apiGet(`/api/ai/memory/history?${params.memoryId ? `memory_id=${encodeURIComponent(params.memoryId)}` : "deleted=true"}`),
      restore: (versionId: string): Promise<PersonalMemory> => apiSend(`/api/ai/memory/history/${encodeURIComponent(versionId)}/restore`, "POST"),
      organize: {
        start: (input: { text?: string; file?: File }): Promise<OrganizeJob> => {
          const form = new FormData();
          if (input.file) form.append("file", input.file, input.file.name);
          else form.append("text", input.text ?? "");
          return sendForm("/api/ai/memory/organize", form);
        },
        list: (): Promise<{ items: OrganizeJob[] }> => apiGet("/api/ai/memory/organize"),
        get: (id: string): Promise<OrganizeJob> => apiGet(`/api/ai/memory/organize/${encodeURIComponent(id)}`),
        retry: (id: string): Promise<OrganizeJob> => apiSend(`/api/ai/memory/organize/${encodeURIComponent(id)}/retry`, "POST"),
        discard: (id: string): Promise<void> => apiSend(`/api/ai/memory/organize/${encodeURIComponent(id)}`, "DELETE"),
        apply: applyOrganize,
      },
      remove: (id: string): Promise<void> => apiSend(`/api/ai/memory/${encodeURIComponent(id)}`, "DELETE"),
      preference: (enabled: boolean): Promise<{ enabled: boolean }> => apiSend("/api/ai/memory/preferences", "PUT", { enabled }),
      suggestions: (status: MemorySuggestion["status"] = "pending"): Promise<{ items: MemorySuggestion[] }> =>
        apiGet(`/api/ai/memory/suggestions?status=${status}`),
      accept: (id: string, edits: { key?: string; content?: string; category?: string; kind?: MemoryKind; keep_history?: boolean } = {}): Promise<MemorySuggestion> =>
        apiSend(`/api/ai/memory/suggestions/${encodeURIComponent(id)}/accept`, "POST", edits),
      reject: (id: string): Promise<MemorySuggestion> => apiSend(`/api/ai/memory/suggestions/${encodeURIComponent(id)}/reject`, "POST"),
      acceptAll: (ids: string[]): Promise<{ accepted: number; failed: { id: string; key: string; error: string }[] }> =>
        apiSend("/api/ai/memory/suggestions/accept-all", "POST", { ids }),
    },
    routines: {
      list: (): Promise<NovaRoutines> => apiGet("/api/ai/nova/routines"),
      create: (payload: RoutineInput): Promise<NovaRoutine> => apiSend("/api/ai/nova/routines", "POST", payload),
      update: (id: string, payload: Partial<RoutineInput>): Promise<NovaRoutine> =>
        apiSend(`/api/ai/nova/routines/${encodeURIComponent(id)}`, "PATCH", payload),
      remove: (id: string): Promise<void> => apiSend(`/api/ai/nova/routines/${encodeURIComponent(id)}`, "DELETE"),
      run: (id: string): Promise<{ queued: boolean }> => apiSend(`/api/ai/nova/routines/${encodeURIComponent(id)}/run`, "POST"),
      settings: (payload: ProactiveSettings): Promise<ProactiveSettings> => apiSend("/api/ai/nova/proactive", "PUT", payload),
      sources: (): Promise<NovaDataSources> => apiGet("/api/ai/nova/data-sources"),
      testSources: (): Promise<DataSourceTest> => apiSend("/api/ai/nova/data-sources/test", "POST"),
    },
    imports: {
      status: (): Promise<ImportStatus> => apiGet("/api/ai/imports"),
      preview: (kind: ImportKind, source: ImportSource, file: Blob, name: string) => uploadImport("/api/ai/imports/preview", kind, source, file, name),
      apply: (kind: ImportKind, source: ImportSource, file: Blob, name: string) => uploadImport("/api/ai/imports", kind, source, file, name),
      estimate: (): Promise<ImportEstimate> => apiGet("/api/ai/imports/suggest-estimate"),
      suggest: (): Promise<ImportEstimate & { queued: boolean }> => apiSend("/api/ai/imports/suggest", "POST", { confirm: true }),
      remove: (source: ImportSource): Promise<{ deleted_conversations: number; deleted_suggestions: number; deleted_notes: number }> =>
        apiSend(`/api/ai/imports/${source}`, "DELETE"),
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
    ask: (message: string, agent = "coordinator", conversationKey?: string,
          context?: { page: string; path: string; items: { label: string; value: string }[] }): Promise<AITask> =>
      apiSend("/api/ai/ask", "POST", { message, agent, conversation_key: conversationKey, ...(context ? { context } : {}) }),
    usage: (days = 7): Promise<AIUsageResponse> => apiGet(`/api/ai/usage?days=${days}`),
    tasks: {
      cancel: (id: string): Promise<AITask> => apiSend(`/api/ai/tasks/${id}/cancel`, "POST"),
      list: (limit = 50, filter: { agent?: string; mine?: boolean } = {}): Promise<AITask[]> =>
        apiGet(`/api/ai/tasks?limit=${limit}${filter.agent ? `&agent=${encodeURIComponent(filter.agent)}` : ""}${filter.mine ? "&mine=true" : ""}`),
      get: (id: string): Promise<AITask> => apiGet(`/api/ai/tasks/${id}`),
      board: (id: string): Promise<AITaskBoard> => apiGet(`/api/ai/tasks/${id}/board`),
      resume: (id: string): Promise<{ task_id: string }> => apiSend(`/api/ai/tasks/${id}/resume`, "POST"),
    },
    developer: {
      overview: (): Promise<DevOverview> => apiGet("/api/ai/developer/overview"),
      change: (id: string): Promise<DevChangeDetail> => apiGet(`/api/ai/developer/changes/${id}`),
    },
    proposals: {
      list: (status?: string): Promise<AIToolProposal[]> => apiGet(`/api/ai/proposals${status ? `?status=${status}` : ""}`),
      approve: (id: string): Promise<AIToolProposal> => apiSend(`/api/ai/proposals/${id}/approve`, "POST"),
      reject: (id: string): Promise<AIToolProposal> => apiSend(`/api/ai/proposals/${id}/reject`, "POST"),
      deployed: (id: string, note = "", release_ref = ""): Promise<AIToolProposal> => apiSend(`/api/ai/proposals/${id}/deployed`, "POST", { note, release_ref }),
      review: (id: string, decision: "approve" | "request_changes" | "reject", comment = "", patch_sha256?: string | null): Promise<{ stage: DevStage }> =>
        apiSend(`/api/ai/proposals/${id}/review`, "POST", { decision, comment, patch_sha256: patch_sha256 ?? null }),
      releaseOutcome: (id: string, outcome: "release_failed" | "rolled_back", note: string, release_ref = ""): Promise<{ stage: DevStage }> =>
        apiSend(`/api/ai/proposals/${id}/release-outcome`, "POST", { outcome, note, release_ref }),
      patch: async (id: string): Promise<string> => {
        await renewSession();
        const token = getToken();
        const res = await apiFetch(`/api/ai/proposals/${id}/patch`, { headers: authHeaders(token) });
        if (!res.ok) {
          handleUnauthorized(res, token);
          throw new ApiError(await safeDetail(res), res.status);
        }
        return res.text();
      },
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
