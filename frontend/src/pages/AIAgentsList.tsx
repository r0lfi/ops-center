import { McpAccessBanner } from "@/components/ai/McpAgentAccess";
import { PageHeader } from "@/components/layout/PageHeader";
import { AgentBadge } from "@/components/ai/AgentIdentity";
import { useEffect, useState } from "react";
import { MessageSquare, Plus, Power, PowerOff, Settings2, Trash2, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";

import { ProviderKeyDialog } from "@/components/ai/ProviderKeyDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { api, type AgentStatus, type AIAgent, type AIFinding, type AIProvider } from "@/lib/api";

const STATUS_VARIANT: Record<AgentStatus, "ok" | "warning" | "critical" | "unknown" | "secondary"> = {
  idle: "secondary",
  working: "ok",
  waiting: "unknown",
  investigating: "ok",
  error: "critical",
  disabled: "unknown",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Anything but a self-hosted endpoint sends prompts to a third party. */
export function isCloudProvider(provider: AIProvider | undefined): boolean {
  return provider?.kind === "anthropic" || provider?.kind === "openai" || provider?.kind === "mistral";
}

function AgentConfigDialog({
  agent,
  providers,
  onSaved,
}: {
  agent: AIAgent;
  providers: AIProvider[];
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState(agent.provider_id ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [maxToolCalls, setMaxToolCalls] = useState(agent.max_tool_calls);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !open) {
      setProviderId(agent.provider_id ?? "");
      setModel(agent.model ?? "");
      setSystemPrompt(agent.system_prompt);
      setMaxToolCalls(agent.max_tool_calls);
      setEnabled(agent.enabled);
    }
    setOpen(nextOpen);
  }

  async function save() {
    setSaving(true);
    try {
      await api.ai.agents.update(agent.id, {
        provider_id: providerId || null,
        model: model.trim() || null,
        system_prompt: systemPrompt,
        max_tool_calls: maxToolCalls,
        enabled,
      } as Partial<AIAgent>);
      onSaved();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${agent.name}? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.ai.agents.remove(agent.id);
      onSaved();
      setOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Settings2 className="h-3.5 w-3.5" />
          Configuration
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{agent.name} - configuration</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`agent-provider-${agent.id}`}>Provider</Label>
            <select
              id={`agent-provider-${agent.id}`}
              className="w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">(none)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({p.kind})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`agent-model-${agent.id}`}>Model override (blank = provider default)</Label>
            <Input id={`agent-model-${agent.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o, claude-sonnet-5" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`agent-prompt-${agent.id}`}>System prompt</Label>
            <textarea
              id={`agent-prompt-${agent.id}`}
              className="min-h-32 w-full resize-y rounded-md border border-input bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">Advanced run safety</summary>
            <p className="text-xs text-muted-foreground">The shared weekly budget controls spending. This safety limit stops repeated tool calls in one run.</p>
            <Label htmlFor={`tool-rounds-${agent.id}`}>Maximum tool calls per run</Label>
            <Input
              type="number"
              min={1}
              max={256}
              id={`tool-rounds-${agent.id}`}
              value={maxToolCalls}
              onChange={(e) => setMaxToolCalls(Number(e.target.value))}
            />
          </details>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Allowed tools: {agent.allowed_tools.join(", ") || "(none)"}</p>
            <p>Allowed hosts: {agent.allowed_hosts.join(", ") || "all"}</p>
            <p>Allowed environments: {agent.allowed_environments.join(", ") || "all"}</p>
            {agent.allowed_dispatch_targets && <p>Can delegate to: {agent.allowed_dispatch_targets.join(", ") || "(none)"}</p>}
            {agent.personal && <p>Personal agent: no other agent can delegate to it and its conversations are visible only to their owner.</p>}
          </div>
          {agent.personal && isCloudProvider(providers.find((p) => p.id === providerId)) && (
            <p role="alert" className="rounded-md border border-status-warning/60 p-2 text-xs text-status-warning">
              {agent.name} will send your conversations, notes and history excerpts to this cloud provider.
            </p>
          )}
        </div>
        <DialogFooter className="justify-between">
          {agent.slug !== "coordinator" ? (
            <Button variant="ghost" className="text-status-critical" onClick={remove} disabled={deleting}>
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? "Deleting..." : "Delete agent"}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentCreateDialog({ providers, onCreated }: { providers: AIProvider[]; onCreated: () => void }) {
  const anthropic = providers.find((p) => p.kind === "anthropic");
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState(anthropic?.id ?? "");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [allowedTools, setAllowedTools] = useState("web_search, web_fetch");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSlug("");
    setName("");
    setDescription("");
    setProviderId(anthropic?.id ?? "");
    setModel("");
    setSystemPrompt("");
    setAllowedTools("web_search, web_fetch");
    setError(null);
  }

  async function create() {
    setError(null);
    if (!slug.trim() || !name.trim()) {
      setError("slug and name are required");
      return;
    }
    setSaving(true);
    try {
      await api.ai.agents.create({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        provider_id: providerId || null,
        model: model.trim() || null,
        system_prompt: systemPrompt,
        allowed_tools: allowedTools
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onCreated();
      setOpen(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to create agent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          New Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Slug (lowercase, no spaces)</Label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="chat" />
            </div>
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Chat Agent" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent is for"
            />
          </div>
          <div className="space-y-1">
            <Label>Provider</Label>
            <select
              className="w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">(none)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({p.kind})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Model override (blank = provider default)</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o" />
          </div>
          <div className="space-y-1">
            <Label>System prompt</Label>
            <textarea
              className="min-h-24 w-full resize-y rounded-md border border-input bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant for..."
            />
          </div>
          <div className="space-y-1">
            <Label>Allowed tools (comma-separated, blank = none)</Label>
            <Input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} />
          </div>
          {error && <p className="text-sm text-status-critical">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={saving}>
            {saving ? "Creating..." : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AIAgentsList() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");

  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [findings, setFindings] = useState<AIFinding[]>([]);
  const [toggling, setToggling] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function refresh() {
    api.ai.providers.list().then(setProviders).catch(() => {});
    api.ai.agents.list().then(setAgents).catch(() => {});
    api.ai.findings.list(50).then(setFindings).catch(() => {});
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  const findingCountByAgent = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.agent_id] = (acc[f.agent_id] ?? 0) + 1;
    return acc;
  }, {});

  const enabledCount = agents.filter((a) => a.enabled).length;

  async function setEnabled(agent: AIAgent, enabled: boolean) {
    setToggling((prev) => new Set(prev).add(agent.id));
    try {
      const updated = await api.ai.agents.update(agent.id, { enabled });
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      /* apiSend already shows the failure as a toast */
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(agent.id);
        return next;
      });
    }
  }

  async function setAllEnabled(enabled: boolean) {
    const targets = agents.filter((a) => a.enabled !== enabled);
    if (!targets.length) return;
    if (!enabled && !confirm(`Disable all ${targets.length} enabled agents? They stop taking new tasks (chat, Talk, incident investigations) until enabled again.`)) return;
    setBulkBusy(true);
    try {
      await Promise.allSettled(targets.map((a) => setEnabled(a, enabled)));
    } finally {
      setBulkBusy(false);
      refresh();
    }
  }

  const providerById = providers.reduce<Record<string, AIProvider>>((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader title="Agents" actions={isAdmin && <AgentCreateDialog providers={providers} onCreated={refresh} />} />
      <McpAccessBanner />

      {isAdmin && agents.length > 0 && (
        <Card className={cn(enabledCount === 0 && "border-status-critical/60")}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-semibold">
                {enabledCount === 0 ? "All agents are disabled" : `${enabledCount} of ${agents.length} agents enabled`}
              </p>
              <p className="text-xs text-muted-foreground">Disabled agents take no new tasks from chat, Talk or incident investigations.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {enabledCount > 0 && (
                <Button variant="destructive" disabled={bulkBusy} onClick={() => setAllEnabled(false)}>
                  <PowerOff className="h-4 w-4" />
                  Disable all agents
                </Button>
              )}
              {enabledCount < agents.length && (
                <Button variant="outline" disabled={bulkBusy} onClick={() => setAllEnabled(true)}>
                  <Power className="h-4 w-4" />
                  Enable all agents
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">
        Spending is limited by the <Link className="text-primary hover:underline" to="/settings?tab=ai">weekly AI budget</Link>.
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Providers</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {providers.map((p) => (
            <div key={p.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.display_name}</span>
                <Badge variant={p.enabled ? "ok" : "unknown"}>{p.enabled ? "enabled" : "disabled"}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {p.default_model || "no default model set"}
                {p.kind !== "ollama" && <> - key {p.has_key ? "configured" : p.kind === "openai_compatible" ? "optional" : "not set"}</>}
              </p>
              {isAdmin && <ProviderKeyDialog provider={p} onSaved={refresh} />}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <Card key={agent.id} className={cn(!agent.enabled && "border-dashed opacity-70")}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex min-w-0 items-center gap-2 text-base"><AgentBadge slug={agent.slug} size={28} /><span>{agent.name}</span>{agent.runtime === "external" && <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground" title="Runs outside Ops Center and reports its own state">external</span>}</CardTitle>
              {agent.enabled ? (
                <Badge variant={STATUS_VARIANT[agent.status]}>{agent.status}</Badge>
              ) : (
                <Badge variant="critical">disabled</Badge>
              )}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">{agent.description}</p>
              <p>
                <span className="text-muted-foreground">Model: </span>
                {providerById[agent.provider_id ?? ""]?.display_name ?? "no provider"}
                {" / "}
                {agent.model || providerById[agent.provider_id ?? ""]?.default_model || "default"}
              </p>
              <p>
                <span className="text-muted-foreground">Currently: </span>
                {agent.current_task || "idle"}
              </p>
              <p>
                <span className="text-muted-foreground">Last activity: </span>
                {timeAgo(agent.last_activity_at)}
              </p>
              <p>
                <span className="text-muted-foreground">Findings: </span>
                {findingCountByAgent[agent.id] ?? 0}
              </p>
              {agent.error_message && <p className="text-status-critical">{agent.error_message}</p>}
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/ai-agents/chat?agent=${agent.slug}`}>
                    <MessageSquare className="h-3.5 w-3.5" />
                    Ask Agent
                  </Link>
                </Button>
                {agent.slug === "nova" && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/ai-agents/nova">
                      <UserRound className="h-3.5 w-3.5" />
                      Open Nova
                    </Link>
                  </Button>
                )}
                {isAdmin && <AgentConfigDialog agent={agent} providers={providers} onSaved={refresh} />}
                {isAdmin && (
                  <Button
                    size="sm"
                    variant={agent.enabled ? "outline" : "default"}
                    className={cn("ml-auto", agent.enabled && "border-status-critical/50 text-status-critical hover:text-status-critical")}
                    disabled={toggling.has(agent.id) || bulkBusy}
                    onClick={() => setEnabled(agent, !agent.enabled)}
                  >
                    {agent.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    {agent.enabled ? "Disable" : "Enable"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
