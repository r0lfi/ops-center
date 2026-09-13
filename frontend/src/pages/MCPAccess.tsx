import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Tool = { name: string; description: string; scope: string; minimum_role: string; method: string };
type Settings = { enabled: boolean; revision: number; public_url: string | null; tools: Tool[]; scopes: string[] };
type Client = { id: string; name: string; enabled: boolean; redirect_uris: string[]; allowed_tools: string[]; allowed_user_ids: string[]; scopes: string[] };
type Grant = { id: string; client_id: string; user_id: string; agent_id: string | null; allowed_tools: string[]; expires_at: string; revoked_at: string | null };
type Approval = { request_id: string; tool: string; status: string; argument_digest: string; arguments: unknown; result: unknown; expires_at: string };
type User = { id: string; username: string; role: string; is_active: boolean };
type Agent = { id: string; name: string; allowed_tools: string[]; enabled: boolean };
type Audit = { id: string; created_at: string; operation: string; outcome: string; user_id: string | null; client_id: string | null };
const panel = "rounded-xl border border-border bg-card p-5 space-y-4";
const blank = { id: "", name: "", enabled: true, redirect_uris: [], allowed_tools: [], allowed_user_ids: [], scopes: [] } as Client;
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(v => v !== value) : [...values, value]; }

export function ToolPicker({ tools, selected, onChange }: { tools: Tool[]; selected: string[]; onChange: (v: string[]) => void }) {
  const [search, setSearch] = useState("");
  return <div className="space-y-2">
    <Input aria-label="Search tools" placeholder="Search tools or domains" value={search} onChange={e => setSearch(e.target.value)} />
    <p className="text-sm text-muted-foreground">{selected.length} tools selected. Write tools always require human approval.</p>
    <div className="max-h-72 overflow-auto rounded border p-2">
      {tools.filter(t => (t.name + t.scope + t.description).toLowerCase().includes(search.toLowerCase())).map(t =>
        <label key={t.name} className="flex gap-3 border-b border-border p-2 text-sm">
          <input type="checkbox" checked={selected.includes(t.name)} onChange={() => onChange(toggle(selected, t.name))} />
          <span><strong>{t.name}</strong> <span className="text-muted-foreground">{t.method === "GET" ? "Read" : "Approval required"} · {t.minimum_role}</span>
          <span className="block text-muted-foreground">{t.description}</span></span>
        </label>)}
    </div>
  </div>;
}

export default function MCPAccess() {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [requests, setRequests] = useState<Approval[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [draft, setDraft] = useState<Client>(blank);
  const [redirects, setRedirects] = useState("");
  const [agentId, setAgentId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [agentTools, setAgentTools] = useState<string[]>([]);
  const [days, setDays] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const [g, r] = await Promise.all([apiGet<Grant[]>("/api/mcp/grants"), apiGet<Approval[]>("/api/mcp/requests")]);
    setGrants(g); setRequests(r);
    if (admin) {
      const [s, c, u, a, events] = await Promise.all([apiGet<Settings>("/api/mcp/settings"), apiGet<Client[]>("/api/mcp/clients"),
        apiGet<User[]>("/api/users"), apiGet<Agent[]>("/api/ai/agents"), apiGet<Audit[]>("/api/mcp/audit")]);
      setSettings(s); setClients(c); setUsers(u); setAgents(a); setAudit(events);
    }
  }, [admin]);
  useEffect(() => { void load().catch(e => setMessage(String(e))); }, [load]);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await action(); await load(); setMessage(success); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function saveClient() {
    const scopes = ["ops:connect", ...new Set((settings?.tools ?? []).filter(t => draft.allowed_tools.includes(t.name)).map(t => t.scope))];
    const body = { name: draft.name, enabled: draft.enabled, redirect_uris: redirects.split("\n").map(v => v.trim()).filter(Boolean),
      allowed_tools: draft.allowed_tools, allowed_user_ids: draft.allowed_user_ids, scopes };
    const result = await apiSend<Client>("/api/mcp/clients" + (draft.id ? "/" + draft.id : ""), draft.id ? "PUT" : "POST", body);
    setDraft(result); setRedirects(result.redirect_uris.join("\n"));
  }
  async function grantAgent() {
    const agent = agents.find(a => a.id === agentId);
    if (!agent || !ownerId || !agentTools.length) throw new Error("Choose an agent, task owner and tools.");
    await apiSend("/api/ai/agents/" + agent.id, "PATCH", { allowed_tools: [...new Set([...agent.allowed_tools, ...agentTools])] });
    await apiSend("/api/mcp/agent-grants", "POST", { agent_id: agent.id, user_id: ownerId, allowed_tools: agentTools, days });
  }
  return <div className="mx-auto max-w-6xl space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">MCP access</h1>
      <p className="text-muted-foreground">Connect external clients and Ops Floor agents to controlled operational tools.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void run(load, "Refreshed.")}>Refresh</Button></div>
    {message && <p role="status" className="rounded border p-3 text-sm">{message}</p>}
    {admin && settings && <>
      <section className={panel}><h2 className="text-lg font-semibold">Service</h2>
        <p>Status: <strong>{settings.enabled ? "Enabled" : "Disabled"}</strong></p>
        <p className="break-all text-sm">MCP endpoint: {settings.public_url ?? "Set MCP_PUBLIC_URL to your HTTPS /mcp endpoint and restart the API and AI worker."}</p>
        <p className="text-sm text-muted-foreground">Streamable HTTP · OAuth authorization code with PKCE · exact registered redirects · short-lived access tokens.
          Client registration is managed here. Existing browser/API tokens cannot connect to MCP.</p>
        <Button disabled={busy || (!settings.enabled && !settings.public_url)} onClick={() => void run(() => apiSend("/api/mcp/settings", "PUT",
          { enabled: !settings.enabled, revision: settings.revision }), "Service updated.")}>{settings.enabled ? "Disable MCP" : "Enable MCP"}</Button>
      </section>
      <section className={panel}><h2 className="text-lg font-semibold">External clients</h2>
        <p className="text-sm text-muted-foreground">Each client needs its own registration. Configure its client ID, endpoint, exact callback URI and the scopes shown below.
          Users sign in to Ops Center and choose a subset of these tools before access is granted.</p>
        <div className="flex flex-wrap gap-2">{clients.map(c => <Button key={c.id} variant="outline" onClick={() => { setDraft(c); setRedirects(c.redirect_uris.join("\n")); }}>{c.name}{!c.enabled && " (disabled)"}</Button>)}
          <Button variant="outline" onClick={() => { setDraft(blank); setRedirects(""); }}>New client</Button></div>
        <label className="block text-sm">Client name<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        {draft.id && <p className="break-all text-sm">Client ID: <code>{draft.id}</code></p>}
        <label className="block text-sm">Exact redirect URIs, one per line<textarea className="mt-1 w-full rounded border bg-background p-2" rows={3} placeholder="https://client.example.com/oauth/callback"
          value={redirects} onChange={e => setRedirects(e.target.value)} /></label>
        <fieldset><legend className="mb-2 text-sm font-medium">Permitted users</legend><div className="flex flex-wrap gap-4">{users.filter(u => u.is_active).map(u =>
          <label key={u.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.allowed_user_ids.includes(u.id)}
            onChange={() => setDraft({ ...draft, allowed_user_ids: toggle(draft.allowed_user_ids, u.id) })} />{u.username} ({u.role})</label>)}</div></fieldset>
        <ToolPicker tools={settings.tools} selected={draft.allowed_tools} onChange={allowed_tools => setDraft({ ...draft, allowed_tools })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Client enabled</label>
        {draft.id && <p className="break-all text-sm">Scopes: <code>{draft.scopes.join(" ")}</code></p>}
        <Button disabled={busy} onClick={() => void run(saveClient, "Client saved. Existing grants cannot gain new permissions without new consent.")}>Save client</Button>
      </section>
      <section className={panel}><h2 className="text-lg font-semibold">Ops Floor agent access</h2>
        <p className="text-sm text-muted-foreground">Enable selected MCP tools on an agent and grant them for tasks started by one user. Existing tools are retained.
          Agent host restrictions still apply; tools that cannot safely enforce those restrictions are denied. Scheduled and collaboration tasks cannot use this access.</p>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="text-sm"><label htmlFor="mcp-agent">Agent</label><select id="mcp-agent" className="block w-full rounded border bg-background p-2" value={agentId} onChange={e => setAgentId(e.target.value)}>
            <option value="">Choose agent</option>{agents.filter(a => a.enabled).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="text-sm"><label htmlFor="mcp-owner">Task owner</label><select id="mcp-owner" className="block w-full rounded border bg-background p-2" value={ownerId} onChange={e => setOwnerId(e.target.value)}>
            <option value="">Choose user</option>{users.filter(u => u.is_active).map(u => <option key={u.id} value={u.id}>{u.username}</option>)}</select></div>
          <label className="text-sm">Expires in days<Input type="number" min={1} max={30} value={days} onChange={e => setDays(Number(e.target.value))} /></label>
        </div>
        <ToolPicker tools={settings.tools} selected={agentTools} onChange={setAgentTools} />
        <Button disabled={busy} onClick={() => void run(grantAgent, "Agent tools enabled and access granted.")}>Enable tools and grant access</Button>
      </section>
    </>}
    <section className={panel}><h2 className="text-lg font-semibold">Authorizations</h2>
      {!grants.length && <p className="text-sm text-muted-foreground">No authorizations.</p>}
      {grants.map(g => <div key={g.id} className="flex flex-wrap justify-between gap-3 border-t pt-3 text-sm"><div>
        <p>{g.agent_id ? "Ops Floor agent" : "External client"} · <code>{g.client_id}</code></p>
        <p>{g.allowed_tools.length} tools · Expires {new Date(g.expires_at).toLocaleString()} · {g.revoked_at ? "Revoked" : "Authorized"}</p>
      </div><Button variant="outline" disabled={busy || Boolean(g.revoked_at)} onClick={() => void run(() => apiSend("/api/mcp/grants/" + g.id, "DELETE"), "Access revoked.")}>Revoke</Button></div>)}
    </section>
    <section className={panel}><h2 className="text-lg font-semibold">Change requests</h2>
      <p className="text-sm text-muted-foreground">Review the exact target and arguments. Approval executes once with the original user's current permissions. An unknown outcome requires inspection before retrying.</p>
      {!requests.length && <p className="text-sm text-muted-foreground">No change requests.</p>}
      {requests.map(r => <article key={r.request_id} className="space-y-3 rounded border p-4">
        <p className="font-medium">{r.tool} · {r.status}</p><p className="break-all text-xs text-muted-foreground">{r.request_id} · Expires {new Date(r.expires_at).toLocaleString()}</p>
        {r.arguments != null && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(r.arguments, null, 2)}</pre>}
        {r.result != null && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(r.result, null, 2)}</pre>}
        {r.status === "pending" && r.arguments != null && <div className="flex gap-2">
          <Button disabled={busy} onClick={() => void run(() => apiSend("/api/mcp/requests/" + r.request_id + "/decision", "POST",
            { approve: true, argument_digest: r.argument_digest }), "Decision recorded. Check the resulting request/job status.")}>Approve exact request</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(() => apiSend("/api/mcp/requests/" + r.request_id + "/decision", "POST",
            { approve: false, argument_digest: r.argument_digest }), "Request rejected.")}>Reject</Button>
        </div>}
      </article>)}
    </section>
    {admin && <section className={panel}><h2 className="text-lg font-semibold">Recent MCP audit</h2>
      <p className="text-sm text-muted-foreground">Metadata only. Tokens, arguments and operational results are not included.</p>
      <div className="max-h-80 overflow-auto">{audit.map(a => <div key={a.id} className="border-t py-2 text-sm">{new Date(a.created_at).toLocaleString()} · {a.operation} · {a.outcome}</div>)}</div>
    </section>}
  </div>;
}
