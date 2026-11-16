import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AgentBadge } from "@/components/ai/AgentIdentity";
import { NovaImport } from "@/components/ai/NovaImport";
import { NovaRoutines } from "@/components/ai/NovaRoutines";
import { MemoryOverview } from "@/components/ai/MemoryOverview";
import { OrganizeMemory } from "@/components/ai/OrganizeMemory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type AIAction, type AIAgent, type AIProvider, type AITask, type MemorySuggestion, type PersonalMemory } from "@/lib/api";
import { isCloudProvider } from "@/pages/AIAgentsList";
import { formatDateTime } from "@/lib/format";

const SLUG = "nova";

function when(iso: string) {
  return formatDateTime(iso);
}

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-sm">{children}</div>
    </div>
  );
}

function ProviderStatus({ agent, provider }: { agent: AIAgent; provider: AIProvider | undefined }) {
  if (!provider) {
    return <p role="alert" className="text-status-critical">No provider selected. Choose one in the agent's configuration.</p>;
  }
  const cloud = isCloudProvider(provider);
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center justify-end gap-2">
        <span>{provider.display_name} / {agent.model || provider.default_model || "default model"}</span>
        <Badge variant={cloud ? "warning" : "ok"}>{cloud ? "Cloud" : "Local"}</Badge>
        {!provider.enabled && <Badge variant="critical">provider disabled</Badge>}
      </p>
      {cloud ? (
        <p role="alert" className="text-xs text-status-warning">Your conversations, notes and history excerpts are sent to {provider.display_name}.</p>
      ) : (
        <p className="text-xs text-muted-foreground">Requests go to a self-hosted model endpoint.</p>
      )}
    </div>
  );
}

function Overview({ agent, provider, memoryEnabled, busy, onMemory }: {
  agent: AIAgent; provider: AIProvider | undefined; memoryEnabled: boolean | null; busy: boolean; onMemory: (enabled: boolean) => void;
}) {
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [pending, setPending] = useState<AIAction[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([api.ai.tasks.list(100, { agent: SLUG, mine: true }), api.ai.actions.list("pending", 100)])
      .then(([mine, actions]) => {
        if (!live) return;
        const ids = new Set(mine.map((t) => t.id));
        setTasks(mine.filter((t) => t.agents_used.some((slug) => slug !== SLUG)));
        setPending(actions.filter((a) => a.task_id && ids.has(a.task_id)));
      })
      .catch((err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Status</CardTitle></CardHeader>
        <CardContent>
          <StatusRow label="Agent">
            <Badge variant={agent.enabled ? "ok" : "critical"}>{agent.enabled ? agent.status : "disabled"}</Badge>
          </StatusRow>
          <StatusRow label="Model provider"><ProviderStatus agent={agent} provider={provider} /></StatusRow>
          <StatusRow label="Long-term memory">
            <label className="flex items-center justify-end gap-2">
              <input type="checkbox" aria-label="Use long-term memory" checked={memoryEnabled === true}
                disabled={memoryEnabled === null || busy} onChange={(e) => onMemory(e.target.checked)} />
              {memoryEnabled ? "On" : memoryEnabled === false ? "Off" : "Loading…"}
            </label>
            {memoryEnabled === false && <p className="mt-1 text-xs text-muted-foreground">Nova uses no notes or earlier conversations. This setting applies to all your agents.</p>}
          </StatusRow>
          <StatusRow label="Proactive messages"><span className="text-muted-foreground">Not available yet</span></StatusRow>
          <p className="pt-3 text-xs text-muted-foreground">
            Change the provider or model in <Link className="text-primary hover:underline" to="/ai-agents/agents">Agents</Link> → Nova → Configuration.
            Nova has no infrastructure tools; it can only ask the Coordinator, and changes still wait for your approval.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Requests to Ops Center</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {pending.length > 0 && (
            <div className="space-y-2 rounded-md border border-status-warning/60 p-3">
              <p className="text-sm font-medium">{pending.length} waiting for approval</p>
              {pending.map((a) => (
                <p key={a.id} className="break-words text-sm"><span className="font-mono text-xs">{a.request_code}</span> {a.action} <Badge variant="warning">{a.risk}</Badge></p>
              ))}
              <Button asChild size="sm" variant="outline"><Link to="/ai-agents/approvals">Review in Approvals</Link></Button>
            </div>
          )}
          {tasks.map((t) => (
            <details key={t.id} className="rounded-md border border-border p-3">
              <summary className="cursor-pointer break-words text-sm">{t.input_message.slice(0, 140)}</summary>
              <p className="mt-2 text-xs text-muted-foreground">{when(t.created_at)} · {t.status} · {t.agents_used.join(" → ")}</p>
              <p className="mt-2 whitespace-pre-wrap break-words rounded bg-accent/50 p-2 text-sm">{t.response_message || t.error_message || "Waiting for a response"}</p>
            </details>
          ))}
          {!error && tasks.length === 0 && <p className="text-sm text-muted-foreground">Nova has not asked Ops Center for anything yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

const SOURCE_LABEL: Record<MemorySuggestion["source"], string> = { conversation: "From a conversation", journal: "From the nightly journal", import: "Imported" };

function SuggestionCard({ suggestion, busy, mutate }: { suggestion: MemorySuggestion; busy: boolean; mutate: (action: () => Promise<unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState(suggestion.key);
  const [content, setContent] = useState(suggestion.content);
  const [keepHistory, setKeepHistory] = useState(true);
  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border p-3" data-suggestion={suggestion.key}>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{SOURCE_LABEL[suggestion.source]}</Badge>
        <Badge variant="outline">{suggestion.agent_id ? "Nova only" : "Shared"}</Badge>
        {when(suggestion.created_at)}
      </p>
      {editing ? (
        <>
          <Input aria-label="Suggested key" value={key} maxLength={100} pattern="[a-zA-Z0-9_.-]+" onChange={(e) => setKey(e.target.value)} />
          <textarea aria-label="Suggested note" className="min-h-20 w-full rounded-md border border-input bg-secondary p-2 text-sm" maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} />
        </>
      ) : (
        <>
          <p className="font-mono text-xs text-primary [overflow-wrap:anywhere]">{suggestion.key}</p>
          {suggestion.target && <p className="text-xs font-medium text-status-warning">Updates an existing note. Current text:</p>}
          {suggestion.target && <p className="whitespace-pre-wrap break-words rounded bg-accent/50 p-2 text-xs">{suggestion.target.content}</p>}
          {suggestion.target && <p className="text-xs font-medium">New text:</p>}
          <p className="whitespace-pre-wrap break-words text-sm">{suggestion.content}</p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {suggestion.target && <label className="flex w-full items-center gap-2 text-xs"><input type="checkbox" checked={keepHistory} onChange={(e) => setKeepHistory(e.target.checked)} />Also keep the current text as a history note</label>}
        <Button size="sm" disabled={busy || !key.trim() || !content.trim()} onClick={() => mutate(() => api.ai.memory.accept(suggestion.id, { ...(editing ? { key: key.trim(), content: content.trim() } : {}), ...(suggestion.target ? { keep_history: keepHistory } : {}) }))}>
          {editing ? "Save and accept" : "Accept"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(!editing); setKey(suggestion.key); setContent(suggestion.content); }}>{editing ? "Cancel edit" : "Edit"}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => mutate(() => api.ai.memory.reject(suggestion.id))}>Reject</Button>
      </div>
    </div>
  );
}

function Suggestions({ items, memoryEnabled, busy, mutate }: {
  items: MemorySuggestion[]; memoryEnabled: boolean | null; busy: boolean; mutate: (action: () => Promise<unknown>) => void;
}) {
  const [result, setResult] = useState<{ accepted: number; failed: { id: string; key: string; error: string }[] } | null>(null);
  const updates = items.filter((s) => s.target).length;
  function acceptAll() {
    const note = updates ? ` ${updates} of them update an existing note; its previous text stays in the note's history.` : "";
    if (!window.confirm(`Accept all ${items.length} suggestions as they are?${note}`)) return;
    mutate(async () => setResult(await api.ai.memory.acceptAll(items.map((s) => s.id))));
  }
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <p className="text-sm text-muted-foreground">
          Nova proposes what it noticed in your conversations and in its nightly journal; imports land here too. Nothing is saved until you accept it,
          and a rejected suggestion is not proposed again.
        </p>
        {memoryEnabled === false && <p role="alert" className="text-sm text-status-warning">Long-term memory is off, so Nova makes no new suggestions and writes no journal.</p>}
        {items.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={acceptAll}>Accept all ({items.length})</Button>
            <span className="text-xs text-muted-foreground">Saves every suggestion below as shown. You can still edit or delete notes afterwards under What Nova knows.</span>
          </div>
        )}
        {result && (
          <div role="status" className="space-y-1 rounded-md border border-border p-3 text-sm" data-accept-all-result>
            <p>Accepted {result.accepted}{result.failed.length ? `; ${result.failed.length} could not be saved and are still listed below` : ""}.</p>
            {result.failed.map((f) => <p key={f.id} className="text-xs text-status-critical [overflow-wrap:anywhere]">{f.key}: {f.error}</p>)}
          </div>
        )}
        {items.map((s) => <SuggestionCard key={s.id} suggestion={s} busy={busy} mutate={mutate} />)}
        {items.length === 0 && <p className="text-sm text-muted-foreground">No suggestions waiting.</p>}
      </CardContent>
    </Card>
  );
}

export default function Nova() {
  const [agent, setAgent] = useState<AIAgent | null | undefined>(undefined);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [notes, setNotes] = useState<PersonalMemory[]>([]);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    api.ai.agents.list().then((agents) => { if (live) setAgent(agents.find((a) => a.slug === SLUG) ?? null); }).catch((err) => { if (live) setError(String(err)); });
    api.ai.providers.list().then((data) => { if (live) setProviders(data); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    api.ai.memory.list().then((data) => { if (live) { setNotes(data.items); setMemoryEnabled(data.enabled); } }).catch((err) => { if (live) setError(String(err)); });
    api.ai.memory.suggestions().then((data) => { if (live) setSuggestions(data.items); }).catch((err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [refresh]);

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError("");
    try { await action(); setRefresh((v) => v + 1); return true; }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AgentBadge slug={SLUG} size={40} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Personal agent (Nova)</h1>
            <p className="text-sm text-muted-foreground">Your personal agent. See and manage what it knows about you and what it has asked Ops Center to do.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link to={`/ai-agents/chat?agent=${SLUG}`}>Chat with Nova</Link></Button>
          <Button asChild variant="outline"><Link to="/ai-agents/approvals">Approvals</Link></Button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {agent === undefined && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {agent === null && <Card><CardContent className="pt-4 text-sm">Nova is not installed. Apply database migration 0053 to add it.</CardContent></Card>}
      {agent && (
        <Tabs defaultValue="overview">
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="knowledge">What Nova knows</TabsTrigger>
            <TabsTrigger value="suggestions">Suggestions{suggestions.length > 0 ? ` (${suggestions.length})` : ""}</TabsTrigger>
            <TabsTrigger value="routines">Routines</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview agent={agent} provider={providers.find((p) => p.id === agent.provider_id)} memoryEnabled={memoryEnabled} busy={busy}
              onMemory={(enabled) => void mutate(() => api.ai.memory.preference(enabled))} />
          </TabsContent>
          <TabsContent value="suggestions">
            <Suggestions items={suggestions} memoryEnabled={memoryEnabled} busy={busy} mutate={(action) => void mutate(action)} />
          </TabsContent>
          <TabsContent value="routines">
            <NovaRoutines />
          </TabsContent>
          <TabsContent value="import">
            <NovaImport onChanged={() => setRefresh((v) => v + 1)} />
          </TabsContent>
          <TabsContent value="knowledge">
            <div className="space-y-4">
              <OrganizeMemory onSaved={() => setRefresh((v) => v + 1)} />
              <MemoryOverview agent={agent} notes={notes} busy={busy} mutate={mutate} />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
