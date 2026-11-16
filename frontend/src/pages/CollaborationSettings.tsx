import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AIAgent, type CollaborationPolicy, type CollaborationPermissions, type CollaborationSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

const fields: { key: keyof Pick<CollaborationPolicy, "max_active_investigations" | "max_tokens" | "max_daily_tokens" | "max_output_tokens" | "max_model_calls" | "max_messages" | "max_help_requests" | "max_depth" | "max_participants" | "max_seconds" | "max_post_chars">; label: string; min: number; max: number }[] = [
  { key: "max_active_investigations", label: "Active investigations · all users", min: 1, max: 20 },
  { key: "max_tokens", label: "Token budget per investigation", min: 2000, max: 2000000 },
  { key: "max_daily_tokens", label: "Daily token budget · all users · UTC", min: 2000, max: 20000000 },
  { key: "max_output_tokens", label: "Maximum output tokens per model call", min: 128, max: 8192 },
  { key: "max_model_calls", label: "Model calls per investigation", min: 1, max: 100 },
  { key: "max_messages", label: "Board messages per investigation", min: 2, max: 200 },
  { key: "max_help_requests", label: "Help requests per investigation", min: 0, max: 30 },
  { key: "max_depth", label: "Maximum nested help requests", min: 1, max: 4 },
  { key: "max_participants", label: "Participants, including lead agent", min: 1, max: 10 },
  { key: "max_seconds", label: "Shared time budget · seconds", min: 15, max: 900 },
  { key: "max_post_chars", label: "Characters per board message", min: 200, max: 8000 },
];
const inputClass = "w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm";
export default function CollaborationSettings() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const [settings, setSettings] = useState<CollaborationSettings | null>(null);
  const [draft, setDraft] = useState<CollaborationPolicy | null>(null);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api.ai.collaboration.settings(), api.ai.agents.list()]).then(([config, list]) => {
      if (live) { setSettings(config); setDraft(config.policy); setAgents(list); setError(""); }
    }).catch(err => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [refresh]);
  async function mutate(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }
  function changePermission(slug: string, patch: Partial<CollaborationPermissions>) {
    setDraft(current => current ? { ...current, agents: { ...current.agents, [slug]: { ...current.agents[slug], ...patch } } } : current);
  }
  function addAgent(slug: string) {
    if (!draft || !slug) return;
    const agent = agents.find(a => a.slug === slug);
    setDraft({ ...draft, agents: { ...draft.agents, [slug]: { read: true, post: true, ask: true, respond: true, peers: [], tools: (agent?.allowed_tools || []).filter(t => settings?.tools.includes(t)) } } });
  }
  function removeAgent(slug: string) {
    if (!draft) return;
    const remaining = Object.fromEntries(Object.entries(draft.agents).filter(([name]) => name !== slug).map(([name, p]) => [name, { ...p, peers: p.peers.filter(peer => peer !== slug) }]));
    setDraft({ ...draft, agents: remaining });
  }
  return <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Collaboration settings</h2><p className="mt-1 text-sm text-muted-foreground">Manage budgets, agent permissions and collaboration rules.</p></div><Button asChild variant="outline"><Link to="/ai-agents/collaboration">Open workspace</Link></Button></div><p className="text-sm text-muted-foreground">Collaboration runs spend from the <Link className="text-primary hover:underline" to="/settings?tab=ai">weekly AI budget</Link>.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}{!settings && !error && <p>Loading collaboration settings…</p>}
    {draft && settings && <form className="space-y-5" onSubmit={event => { event.preventDefault(); void mutate(async () => {
      const saved = await api.ai.collaboration.save(settings.revision, draft); setSettings(saved); setDraft(saved.policy); setNotice("Collaboration settings saved.");
    }); }}>
      <Card><CardContent className="space-y-4 pt-5">
        <h2 className="font-semibold">Availability and run safety</h2>
        <label className="flex items-center gap-2"><input type="checkbox" disabled={!isAdmin || busy} checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })}/>Enable collaboration investigations</label>
        <p className="text-sm text-muted-foreground">Investigations start from the collaboration board. Ordinary chat and scheduled tasks keep their existing behavior. Turning this off stops further collaboration model and tool calls; an in-flight request may finish.</p>
        <p className="text-sm text-muted-foreground">The weekly AI budget above controls shared spending. Additional limits bound the size and duration of each investigation.</p>
        <details className="space-y-3"><summary className="cursor-pointer text-sm font-medium">Advanced investigation safety limits</summary>
        <p className="text-xs text-muted-foreground">Conservative token reservations today: {formatNumber(settings.daily_charged_tokens)} tokens. These are separate from monetary usage.</p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{fields.map(field => <label key={field.key} className="space-y-1 text-sm"><span>{field.label}</span><input className={inputClass} type="number" required min={field.min} max={field.max} step={1} disabled={!isAdmin || busy} value={draft[field.key]} onChange={e => setDraft({ ...draft, [field.key]: Number(e.target.value) })}/></label>)}</div>
        <p className="text-xs text-muted-foreground">Helpers run one at a time. Existing per-agent tool and execution limits also apply. Budget exhaustion produces a report from evidence already collected without another model call. Lower token/call caps and permission revocations apply to running investigations; other limit changes apply to new investigations.</p>
        </details>
      </CardContent></Card>
      <Card><CardContent className="space-y-4 pt-5">
        <h2 className="font-semibold">Agent permissions</h2>
        <p className="text-sm text-muted-foreground">Add agents, choose whom each may consult and select diagnostic tools. Tool grants are intersected with the agent’s existing permissions. Partners must have identical host and environment access. There is no automatic broadcast, operational execution or personal memory access in a collaboration investigation.</p>
        <label className="block space-y-1 text-sm"><span>Add an agent</span><select className={inputClass} value="" disabled={!isAdmin || busy} onChange={e => addAgent(e.target.value)}><option value="">Choose an agent…</option>{agents.filter(a => !draft.agents[a.slug]).map(a => <option key={a.slug} value={a.slug}>{a.name}</option>)}</select></label>
        {Object.entries(draft.agents).map(([slug, permission]) => {
          const agent = agents.find(a => a.slug === slug);
          return <fieldset key={slug} className="space-y-3 rounded-lg border border-border p-4" disabled={!isAdmin || busy}>
            <legend className="px-2 font-medium">{agent?.name || slug}{agent && !agent.enabled ? " · disabled" : ""}</legend>
            <p className="text-xs text-muted-foreground">Hosts: {agent?.allowed_hosts?.join(", ") || "All"} · Environments: {agent?.allowed_environments?.join(", ") || "All"}</p>
            <div className="flex flex-wrap gap-4">{(["read", "post", "ask", "respond"] as const).map(key => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permission[key]} disabled={key !== "read" && !permission.read} onChange={e => changePermission(slug, key === "read" && !e.target.checked ? { read: false, post: false, ask: false, respond: false } : { [key]: e.target.checked })}/>{({ read: "Read board", post: "Post evidence", ask: "Ask for help", respond: "Respond to requests" })[key]}</label>)}</div>
            <p className="text-xs text-muted-foreground">Questions and final answers are recorded automatically when asking/responding is permitted. “Post evidence” controls additional agent-authored posts.</p>
            <details open><summary className="cursor-pointer text-sm font-medium">Permitted partners</summary><div className="mt-2 flex flex-wrap gap-4">{Object.keys(draft.agents).filter(peer => peer !== slug).map(peer => <label key={peer} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permission.peers.includes(peer)} onChange={e => changePermission(slug, { peers: e.target.checked ? [...permission.peers, peer] : permission.peers.filter(p => p !== peer) })}/>{agents.find(a => a.slug === peer)?.name || peer}</label>)}</div></details>
            <details><summary className="cursor-pointer text-sm font-medium">Diagnostic tools ({permission.tools.length})</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">{settings.tools.map(tool => <label key={tool} className="flex items-center gap-2 break-all text-xs"><input type="checkbox" checked={permission.tools.includes(tool)} disabled={!agent?.allowed_tools.includes(tool)} onChange={e => changePermission(slug, { tools: e.target.checked ? [...permission.tools, tool] : permission.tools.filter(t => t !== tool) })}/>{tool}{!agent?.allowed_tools.includes(tool) ? " · not granted to agent" : ""}</label>)}</div></details>
            <Button type="button" variant="outline" size="sm" onClick={() => removeAgent(slug)}>Remove from collaboration</Button>
          </fieldset>;
        })}
        {!Object.keys(draft.agents).length && <p className="text-sm text-muted-foreground">No agents configured. Add a lead agent and at least one helper, then allow the lead to ask that helper.</p>}
      </CardContent></Card>
      <Card><CardContent className="space-y-3 pt-5"><h2 className="font-semibold">Collaboration rules</h2>
        <p className="text-sm text-muted-foreground">These instructions guide the agents. They cannot grant tools, change budgets or override access controls.</p>
        {draft.rules.map((rule, index) => <div key={index} className="flex items-start gap-2"><textarea aria-label={`Rule ${index + 1}`} className={inputClass} required maxLength={1000} disabled={!isAdmin || busy} value={rule} onChange={e => setDraft({ ...draft, rules: draft.rules.map((r, i) => i === index ? e.target.value : r) })}/><Button type="button" variant="outline" disabled={!isAdmin || busy} onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== index) })}>Remove</Button></div>)}
        <Button type="button" variant="outline" disabled={!isAdmin || busy || draft.rules.length >= 30} onClick={() => setDraft({ ...draft, rules: [...draft.rules, ""] })}>Add rule</Button>
      </CardContent></Card>
      <div className="flex flex-wrap items-center gap-3"><Button disabled={!isAdmin || busy}>{busy ? "Saving…" : "Save settings"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(settings.policy); setRefresh(n => n + 1); }}>Reload saved settings</Button>{!isAdmin && <span className="text-sm text-muted-foreground">Administrator access is required to edit settings.</span>}</div>
    </form>}
  </div>;
}
