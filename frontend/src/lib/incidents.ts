import { apiGet, apiSend } from "@/lib/api";
export const imCategories = ["disk", "cpu", "memory", "availability", "certificate", "authentication", "traffic", "monitoring", "other"];
export const imSeverities = ["info", "warning", "high", "critical"];
export interface Incident {
  id: number; category: string; rule: string; resource: string; title: string; severity: string;
  status: string; source_state: string; details: Record<string, unknown>; observations: number; revision: number;
  created_at: string; last_seen: string; completed_at: string | null; updated_by: string | null; talk_policy: string;
}
export interface IncidentDetail extends Incident {
  history: { actor: string; status: string; note: string; created_at: string }[];
  deliveries: { status: string; claimed_at: string | null; sent_at: string | null }[];
  investigation?: { task_id: string | null; status: string; agent_id: string; created_at: string } | null;
}
export interface IMConfig {
  revision: number; workflow_enabled?: boolean; talk_enabled: boolean; categories: string[]; severities: string[];
  excluded_rules: string[]; excluded_resources: string[]; recovery_minutes: number; talk_progress: boolean;
  transport_enabled?: boolean; memory_enabled?: boolean;
  auto_investigate?: boolean; investigation_agent?: string; investigation_owner_user_id?: string | null;
  max_active_investigations?: number;
}
export interface IMList { items: Incident[]; total: number; offset: number; monitor: { checked_at?: number; alertmanager?: string; traffic?: string }; workflow_enabled?: boolean }
export const incidents = {
  list: (params: URLSearchParams) => apiGet<IMList>("/api/incidents?" + params),
  get: (id: string | number) => apiGet<IncidentDetail>("/api/incidents/" + id),
  decide: (id: number, revision: number, status: string, note: string) => apiSend<Incident>("/api/incidents/" + id + "/status", "POST", {revision, status, note}),
  config: () => apiGet<IMConfig>("/api/settings/incidents"),
  saveConfig: (value: IMConfig) => {
    const { transport_enabled: _transport, memory_enabled: _memory, ...body } = value;
    return apiSend<IMConfig>("/api/settings/incidents", "PUT", body);
  },
};
