import { apiGet, apiSend, getToken, renewSession } from "@/lib/api";

export type Outcome =
  | "ok" | "firewall_block" | "dns_block" | "ai_access_control"
  | "remote_reject" | "http_error" | "dns_error" | "connect_error" | "timeout" | "tls_error" | "unknown";

export interface TrafficEvent {
  id: number;
  ts: string;
  ended_at: string | null;
  duration_ms: number | null;
  ttfb_ms: number | null;
  node: string | null;
  kind: "http" | "tcp" | "udp" | "dns" | "access";
  sources: string[];
  trace_id: string | null;
  span_id: string | null;
  task_id: string | null;
  agent_slug: string | null;
  tool: string | null;
  provider: string | null;
  model: string | null;
  mcp_tool: string | null;
  container: string | null;
  pid: number | null;
  process: string | null;
  src_ip: string | null;
  src_port: number | null;
  dst_ip: string | null;
  dst_port: number | null;
  dst_host: string | null;
  protocol: string | null;
  method: string | null;
  path: string | null;
  status_code: number | null;
  bytes_sent: number | null;
  bytes_recv: number | null;
  outcome: Outcome;
  reason: string | null;
  rule_id: string | null;
}

export interface TrafficEventDetail extends TrafficEvent {
  observations: Record<string, unknown>[];
  obs_keys: string[];
  detail: Record<string, unknown>;
}

export interface Span {
  span_id: string;
  parent_span_id: string | null;
  task_id?: string | null;
  kind: "agent" | "model" | "tool" | string;
  name: string;
  agent_slug: string | null;
  node?: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  attributes?: Record<string, unknown>;
}

export interface SourceRow {
  name: string;
  kind: "app" | "capture";
  node: string | null;
  last_seen: string | null;
  last_event_at?: string | null;
  healthy: boolean;
  age?: number;
  stats?: Record<string, unknown>;
  summary: Record<string, number>;
}

export interface CoverageItem {
  node: string | null;
  area: string;
  status: "ok" | "degraded" | "stale" | "missing" | "by_design";
  detail: string;
}

export interface Overview {
  window: string;
  bucket_seconds: number;
  totals: { events: number; connections: number; requests: number; dns: number; ok: number; failed: number; blocked: number; bytes_sent: number; bytes_recv: number };
  requests_last_minute: number;
  requests_last_hour: number;
  active_connections: number;
  by_outcome: { outcome: Outcome; n: number }[];
  top_agents: { agent: string; n: number; problems: number; bytes: number }[];
  top_destinations: { destination: string; provider: string | null; n: number; problems: number; bytes: number }[];
  top_models: { provider: string | null; model: string; n: number; problems: number }[];
  series: { t: string; ok: number; failed: number; blocked: number; bytes_sent: number; bytes_recv: number }[];
  sources: SourceRow[];
  coverage: CoverageItem[];
}

export interface TraceSummary {
  trace_id: string;
  started_at: string;
  ended_at: string | null;
  task_id: string | null;
  root_agent: string | null;
  agents: string[] | null;
  spans: number;
  errors: number;
  events: number;
  problems: number;
}

export interface TraceDetail {
  trace_id: string;
  task: { id: string; source: string; status: string; requested_by: string | null; created_at: string; completed_at: string | null; agent_slug: string | null; agent_name: string | null } | null;
  spans: Span[];
  events: TrafficEvent[];
}

export interface FlowLink {
  origin: string;
  is_agent: boolean;
  via: string | null;
  destination: string;
  provider: string | null;
  n: number;
  problems: number;
  blocked: number;
  bytes: number;
  last_seen: string;
}

export interface Capture {
  id: string;
  node: string;
  requested_by: string;
  requested_at: string;
  seconds: number;
  max_bytes: number;
  status: "pending" | "running" | "done" | "failed";
  finished_at: string | null;
  packets: number | null;
  size: number | null;
  error: string | null;
  expires_at: string | null;
}

export interface TrafficSettings {
  retention_days: number;
  capture_retention_hours: number;
  updated_by: string | null;
  updated_at: string | null;
  storage: { events: number; spans: number; bytes: number; oldest: string | null };
  ingest_configured: boolean;
}

export type MapScope = "external" | "internal" | "local" | "unknown";
export interface MapGroup {
  key: string; agent: string | null; process: string | null; node: string | null; container: string | null;
  model: string | null; provider: string | null; tool: string | null; mcp_tool: string | null;
  src_ip: string | null; src_count: number; dst_ip: string | null; dst_port: number | null; dst_host: string | null;
  protocol: string | null; kind: string; status: OutcomeGroup; outcomes: string[]; reason: string | null;
  count: number; bytes_sent: number; bytes_recv: number; unmeasured: number; first_seen: string; last_seen: string; last_id: number;
  scope: MapScope; category: "ai" | "system"; direction: "outbound" | "inbound"; service: string | null;
  geo: { lat: number; lon: number; city: string | null; country: string | null } | null;
}
export interface TrafficMapData {
  since: string | null; generated_at: string; groups: MapGroup[]; truncated: boolean; group_limit: number;
  sites: Record<string, { lat: number; lon: number }>;
  countries: { country: string; count: number; bytes: number; problems: number }[];
  geoip: boolean; coverage: CoverageItem[];
}

export type EventFilters = Partial<Record<
  "window" | "agent" | "model" | "process" | "container" | "host" | "ip" | "port" | "status" | "kind" | "node" | "trace_id" | "task_id" | "tool" | "q" | "since" | "until",
  string
>>;

function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const aiTraffic = {
  overview: (window: string): Promise<Overview> => apiGet(`/api/ai-traffic/overview${query({ window })}`),
  events: (filters: EventFilters, extra: { limit?: number; offset?: number; after_id?: number } = {}) =>
    apiGet<{ events: TrafficEvent[]; total: number | null; total_capped: boolean; max_id: number }>(
      `/api/ai-traffic/events${query({ ...filters, ...extra })}`),
  event: (id: number) => apiGet<{ event: TrafficEventDetail; span_chain: Span[] }>(`/api/ai-traffic/events/${id}`),
  blocked: (window: string) => apiGet<{ events: TrafficEvent[]; counts: Record<string, number>; approval_denials: { id: string; tool: string; action: string; status: string; risk: string; requested_at: string; expires_at: string | null; approved_by: string | null; task_id: string | null; agent_slug: string | null }[] }>(
    `/api/ai-traffic/blocked${query({ window })}`),
  traces: (window: string, agent?: string) => apiGet<{ traces: TraceSummary[] }>(`/api/ai-traffic/traces${query({ window, agent })}`),
  trace: (id: string) => apiGet<TraceDetail>(`/api/ai-traffic/traces/${id}`),
  map: (filters: EventFilters & { category?: string }) => apiGet<TrafficMapData>(`/api/ai-traffic/map${query(filters)}`),
  flow: (window: string) => apiGet<{ window: string; links: FlowLink[] }>(`/api/ai-traffic/flow${query({ window })}`),
  sources: () => apiGet<{ sources: SourceRow[]; coverage: CoverageItem[] }>("/api/ai-traffic/sources"),
  settings: () => apiGet<TrafficSettings>("/api/ai-traffic/settings"),
  saveSettings: (body: { retention_days: number; capture_retention_hours: number }) => apiSend("/api/ai-traffic/settings", "PUT", body),
  captures: () => apiGet<{ captures: Capture[] }>("/api/ai-traffic/captures"),
  requestCapture: (body: { node: string; seconds: number; max_mb: number }) => apiSend<{ id: string }>("/api/ai-traffic/captures", "POST", body),
  exportUrl: (filters: EventFilters, format: "json" | "csv") => `/api/ai-traffic/export${query({ ...filters, format })}`,
};

/** Authenticated file download (export, PCAP) without exposing the token in a URL. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  await renewSession();
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ""}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type OutcomeGroup = "ok" | "failed" | "blocked";

export const OUTCOMES: Record<Outcome, { label: string; group: OutcomeGroup; help: string }> = {
  ok: { label: "OK", group: "ok", help: "Completed" },
  firewall_block: { label: "Firewall block", group: "blocked", help: "Confirmed or inferred netfilter/firewall rejection (see reason)" },
  dns_block: { label: "DNS block", group: "blocked", help: "Resolver answered with a null address" },
  ai_access_control: { label: "AI access control", group: "blocked", help: "Refused by Ops Center's own AI/MCP policy; no request was sent" },
  remote_reject: { label: "Rejected by service", group: "failed", help: "The remote service refused (401/403/407/451)" },
  http_error: { label: "HTTP error", group: "failed", help: "Other 4xx/5xx response" },
  dns_error: { label: "DNS error", group: "failed", help: "Name did not resolve" },
  connect_error: { label: "Connection error", group: "failed", help: "Refused, unreachable or reset" },
  timeout: { label: "Timeout", group: "failed", help: "No answer in time. Not evidence of a block" },
  tls_error: { label: "TLS error", group: "failed", help: "Handshake or certificate failure" },
  unknown: { label: "Unknown", group: "failed", help: "Failed for a reason the data cannot tell" },
};

/** Status colors (reserved): ok, failed = warning, blocked = critical. Always shown with a label. */
export const GROUP_COLOR: Record<OutcomeGroup, string> = {
  ok: "hsl(var(--status-ok))",
  failed: "hsl(var(--status-warning))",
  blocked: "hsl(var(--status-critical))",
};

export function outcomeGroup(outcome: Outcome | string): OutcomeGroup {
  return OUTCOMES[outcome as Outcome]?.group ?? "failed";
}

export function destination(e: Pick<TrafficEvent, "dst_host" | "dst_ip" | "dst_port" | "kind">): string {
  const host = e.dst_host || e.dst_ip || "—";
  return e.dst_port && e.kind !== "dns" ? `${host}:${e.dst_port}` : host;
}

export function bytesOf(e: Pick<TrafficEvent, "bytes_sent" | "bytes_recv">): number | null {
  if (e.bytes_sent == null && e.bytes_recv == null) return null;
  return (e.bytes_sent ?? 0) + (e.bytes_recv ?? 0);
}

export function action(e: TrafficEvent): string {
  if (e.kind === "access") return e.tool ? `refused ${e.tool}` : "refused";
  if (e.kind === "dns") return "DNS lookup";
  if (e.method) return `${e.method} ${e.path ?? ""}`.trim();
  if (e.protocol === "tls") return "TLS connection";
  return `${(e.protocol ?? e.kind).toUpperCase()} connection`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const msFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** 16:20:15.123: millisecond precision for event lists. */
export function formatTimeMs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${msFormat.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
