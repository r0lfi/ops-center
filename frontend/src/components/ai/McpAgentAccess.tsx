import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

export type AgentAccessRow = {
  agent_id: string; agent: string; agent_slug: string; user_id: string; username: string | null;
  status: "active" | "partial" | "expired" | "missing" | "disabled";
  enabled_tools: string[]; granted_tools: string[]; missing_tools: string[];
  expires_at: string | null; expired_at: string | null;
};
type AccessView = { service_enabled: boolean; rows: AgentAccessRow[] };

const VARIANT = { active: "ok", partial: "warning", expired: "critical", missing: "critical", disabled: "unknown" } as const;
const LABEL = { active: "Active", partial: "Partly granted", expired: "Expired", missing: "Not granted", disabled: "MCP disabled" } as const;
const MAX_DAYS = 30;

function useAgentAccess() {
  const [view, setView] = useState<AccessView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => apiGet<AccessView>("/api/mcp/agent-access").then(v => { setView(v); setError(""); })
    .catch(e => setError(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => { void load(); }, [load]);
  return { view, error, load };
}

function soon(iso: string | null) {
  return Boolean(iso && new Date(iso).getTime() - Date.now() < 3 * 86400_000);
}

/** Warning strip for pages that list agents: shown only when some agent lacks MCP access it is configured for. */
export function McpAccessBanner() {
  const { view } = useAgentAccess();
  const blocked = (view?.rows ?? []).filter(r => r.status !== "active");
  const expiring = (view?.rows ?? []).filter(r => r.status === "active" && soon(r.expires_at));
  if (!blocked.length && !expiring.length) return null;
  const expiredSince = blocked.map(r => r.expired_at).filter(Boolean).sort()[0];
  return (
    <div role="status" className="rounded-md border border-status-warning/50 bg-status-warning/10 p-3 text-sm">
      {blocked.length > 0 && <p><strong>MCP access missing for {new Set(blocked.map(r => r.agent_slug)).size} agent(s)</strong>
        {expiredSince && <> · expired since {formatDateTime(expiredSince)}</>}. Those agents fall back to their native tools and cannot use
        {" "}{new Set(blocked.flatMap(r => r.missing_tools)).size} Ops Center MCP tools.</p>}
      {expiring.length > 0 && <p>MCP access for {expiring.map(r => r.agent).join(", ")} expires within 3 days.</p>}
      <Link className="text-primary hover:underline" to="/ai-agents/mcp-access">Review and renew MCP access</Link>
    </div>
  );
}

/** Full overview per agent and task owner, with renewal for admins. */
export function McpAgentAccess({ admin }: { admin: boolean }) {
  const { view, error, load } = useAgentAccess();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function renew(rows: AgentAccessRow[]) {
    setBusy(rows.length > 1 ? "all" : rows[0].agent_id + rows[0].user_id); setMessage("");
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await apiSend("/api/mcp/agent-grants", "POST", { agent_id: row.agent_id, user_id: row.user_id, allowed_tools: row.enabled_tools, days: MAX_DAYS });
      } catch (e) {
        failed.push(`${row.agent}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setMessage(failed.length ? "Some renewals failed: " + failed.join("; ") : `Access renewed for ${MAX_DAYS} days.`);
    setBusy("");
    await load();
  }

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!view) return <p role="status" className="text-sm text-muted-foreground">Loading agent access…</p>;
  const renewable = view.rows.filter(r => r.status !== "active" && r.status !== "disabled");

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Agents are offered an MCP tool only while a grant for the task owner covers it. Without one they use their native tools,
        and the task view names the missing access. Grants expire after at most {MAX_DAYS} days.
      </p>
      {!view.service_enabled && <p className="text-sm text-status-warning">The MCP service is disabled: no agent can use MCP tools.</p>}
      {message && <p role="status" className="rounded border p-2 text-sm">{message}</p>}
      {admin && renewable.length > 1 && (
        <Button disabled={Boolean(busy)} onClick={() => void renew(renewable)}>Renew all {renewable.length} for {MAX_DAYS} days</Button>
      )}
      <div className="overflow-x-auto">
        <table className="ops-card-table w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Agent</th><th className="px-3 py-2 font-medium">Task owner</th>
              <th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Tools</th>
              <th className="px-3 py-2 font-medium">Valid until</th>{admin && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">No agent has MCP tools enabled.</td></tr>}
            {view.rows.map(row => (
              <tr key={row.agent_id + row.user_id} className="border-b border-border last:border-0 align-top">
                <td data-label="Agent" className="px-3 py-2">{row.agent}</td>
                <td data-label="Task owner" className="px-3 py-2 text-muted-foreground">{row.username ?? "—"}</td>
                <td data-label="Status" className="px-3 py-2"><Badge variant={VARIANT[row.status]}>{LABEL[row.status]}</Badge></td>
                <td data-label="Tools" className="px-3 py-2">
                  {row.granted_tools.length}/{row.enabled_tools.length} granted
                  {row.missing_tools.length > 0 && (
                    <details><summary className="cursor-pointer text-xs text-primary">Missing {row.missing_tools.length}</summary>
                      <p className="break-words text-xs text-muted-foreground">{row.missing_tools.join(", ")}</p></details>
                  )}
                </td>
                <td data-label="Valid until" className="px-3 py-2 text-muted-foreground">
                  {row.expires_at ? <span className={soon(row.expires_at) ? "text-status-warning" : ""}>{formatDateTime(row.expires_at)}</span>
                    : row.expired_at ? <span className="text-status-critical">expired {formatDateTime(row.expired_at)}</span> : "—"}
                </td>
                {admin && <td className="px-3 py-2">
                  {row.status !== "disabled" && (row.status !== "active" || soon(row.expires_at)) && (
                    <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void renew([row])}>Renew</Button>
                  )}
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
