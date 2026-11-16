import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AIAgent } from "@/lib/api";
import { incidents, imCategories, imSeverities, type IMConfig } from "@/lib/incidents";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const split = (value: string) => value.split("\n").map(v => v.trim()).filter(Boolean);
export function IncidentSettingsPanel() {
  const [config, setConfig] = useState<IMConfig | null>(null);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [agentError, setAgentError] = useState("");
  const [rules, setRules] = useState("");
  const [resources, setResources] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    try {
      const value = await incidents.config();
      setConfig(value); setRules(value.excluded_rules.join("\n")); setResources(value.excluded_resources.join("\n")); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load notification settings"); }
  }
  useEffect(() => { void load(); api.ai.agents.list().then(setAgents).catch(() => setAgentError("Agent list is unavailable. Reload settings before changing the investigation agent.")); }, []);
  function toggle(key: "categories" | "severities", value: string) {
    if (config) setConfig({...config, [key]: config[key].includes(value) ? config[key].filter(v => v !== value) : [...config[key], value]});
    setNotice("");
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!config) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const value = await incidents.saveConfig({...config, excluded_rules: split(rules), excluded_resources: split(resources)});
      setConfig({...value, transport_enabled: config.transport_enabled});
      setNotice("Incident notification settings saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    finally { setSaving(false); }
  }
  const workflowOn = config?.workflow_enabled ?? true;
  return <Card id="incident-settings"><CardHeader><CardTitle>Incidents & Talk notifications</CardTitle></CardHeader><CardContent>
    {config && <fieldset className="mb-5 space-y-2 rounded-lg border border-border p-4" disabled={saving}>
      <legend className="px-2 font-medium">Incident workflow</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.workflow_enabled ?? true} onChange={e => { setConfig({...config, workflow_enabled: e.target.checked}); setNotice(""); }}/> Enable incidents and automatic investigations</label>
      <p className="text-xs text-muted-foreground">When off, Ops Center only sends alert notifications to Talk (same categories, severities and exclusions as below). Incidents close themselves after confirmed recovery, no AI investigation starts, and all incident settings are kept for when you turn it back on. Save to apply.</p>
    </fieldset>}
    <p className="mb-4 text-sm text-muted-foreground">Alerts always enter the incident inbox. Choose which new incidents send one notification to each configured administrator Talk room. Changes apply to new incidents and unsent notices; muted history is never replayed.</p>
    {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-emerald-400">{notice}</p>}
    {!config ? <Button onClick={() => void load()}>Load incident settings</Button> : <form className="space-y-5" onSubmit={save}>
      <fieldset aria-describedby={workflowOn ? undefined : "im-investigations-off"} className={`space-y-3 rounded-lg border border-border p-4 ${workflowOn ? "" : "opacity-60"}`} disabled={saving || !workflowOn}>
        <legend className="px-2 font-medium">Automatic incident investigations</legend>
        {!workflowOn && <p id="im-investigations-off" className="text-xs text-status-warning">Not in use while the incident workflow is off. These values are kept for when you turn it back on.</p>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.auto_investigate ?? false} onChange={e => setConfig({...config, auto_investigate: e.target.checked})}/> Investigate new incidents automatically</label>
        <p className="text-xs text-muted-foreground">The selected agent picks up new incoming incidents, gathers evidence and proposes a repair using the shared weekly AI budget. Operational changes follow the existing approval rules. Each incident starts one investigation.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">Investigation agent<select aria-label="Investigation agent" required className="block w-full rounded border border-border bg-background p-2" value={config.investigation_agent || "coordinator"} disabled={!config.auto_investigate || !!agentError} onChange={e => setConfig({...config, investigation_agent: e.target.value})}>
            {!agents.some(agent => agent.slug === (config.investigation_agent || "coordinator")) && <option value={config.investigation_agent || "coordinator"}>{config.investigation_agent || "coordinator"}</option>}
            {agents.map(agent => <option key={agent.id} value={agent.slug} disabled={!agent.enabled}>{agent.name}{agent.enabled ? "" : " (disabled)"}</option>)}
          </select></label>
          <label className="space-y-1 text-sm">Concurrent incident investigations<input aria-label="Concurrent incident investigations" className="block w-full rounded border border-border bg-background p-2" type="number" min={1} max={4} step={1} required disabled={!config.auto_investigate} value={config.max_active_investigations ?? 2} onChange={e => setConfig({...config, max_active_investigations: Number(e.target.value)})}/></label>
        </div>
        {agentError && <p role="status" className="text-xs text-amber-400">{agentError}</p>}
        <p className="break-words text-xs text-muted-foreground">{config.investigation_owner_user_id ? "Investigation owner: configured administrator account." : "Enabling investigations assigns them to the administrator saving these settings."}</p>
        {config.investigation_owner_user_id && <p className={`text-sm ${config.memory_enabled ? "text-emerald-400" : "text-amber-400"}`}>Troubleshooting memory for the investigation owner: {config.memory_enabled ? "enabled" : "disabled"}.</p>}
        <p className="text-xs text-muted-foreground">Memory reuses relevant earlier investigations and saved notes within the owner's account. <Link className="text-primary hover:underline" to="/ai-agents/memory">Manage your memory</Link> · <Link className="text-primary hover:underline" to="/settings?tab=ai">View weekly budget</Link></p>
      </fieldset>
      {config.transport_enabled === false && <p className="text-sm text-amber-400">The Talk transport is disabled in deployment settings. Incident collection remains active.</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.talk_enabled} onChange={e => setConfig({...config, talk_enabled: e.target.checked})}/> Send new incident notifications to Talk</label>
      <fieldset><legend className="mb-2 text-sm font-medium">Notification categories</legend><div className="grid gap-3 sm:grid-cols-3">{imCategories.map(v => <label key={v} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" checked={config.categories.includes(v)} onChange={() => toggle("categories", v)} aria-label={v + " notifications"}/>{v}</label>)}</div></fieldset>
      <fieldset><legend className="mb-2 text-sm font-medium">Notification severities</legend><div className="flex flex-wrap gap-4">{imSeverities.map(v => <label key={v} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" checked={config.severities.includes(v)} onChange={() => toggle("severities", v)} aria-label={v + " notifications"}/>{v}</label>)}</div></fieldset>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm">Excluded rules (one exact incident rule per line)<textarea aria-label="Excluded rules" value={rules} onChange={e => setRules(e.target.value)} className="min-h-24 w-full rounded border border-border bg-background p-2" placeholder="disk_capacity"/></label>
        <label className="space-y-1 text-sm">Excluded resources (one exact incident resource per line)<textarea aria-label="Excluded resources" value={resources} onChange={e => setResources(e.target.value)} className="min-h-24 w-full rounded border border-border bg-background p-2" placeholder="server.example /data"/></label>
      </div>
      <label className="block space-y-1 text-sm">Confirmed recovery before a new recurrence (minutes)<input aria-label="Recovery minutes" type="number" min={30} max={1440} required value={config.recovery_minutes} onChange={e => setConfig({...config, recovery_minutes: Number(e.target.value)})} className="ml-3 w-24 rounded border border-border bg-background p-2"/></label>
      <p className="text-xs text-muted-foreground">Completing an incident keeps the same ongoing problem quiet, including warning-to-critical changes. A new incident requires confirmed recovery followed by a new occurrence. Missing monitoring data never counts as recovery.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.talk_progress} onChange={e => setConfig({...config, talk_progress: e.target.checked})}/> Send progress updates for conversations started in Talk</label>
      <p className="text-xs text-muted-foreground">Conversation answers and operational approval requests remain available. Incident approval acknowledges ownership; it does not execute a repair.</p>
      <div className="flex gap-3"><Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save incident settings"}</Button><Button type="button" variant="outline" disabled={saving} onClick={() => void load()}>Reload settings</Button></div>
    </form>}
  </CardContent></Card>;
}
