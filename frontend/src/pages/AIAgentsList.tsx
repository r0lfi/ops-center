import { useEffect, useState } from "react";
import { MessageSquare, Plus, Settings2, Trash2 } from "lucide-react";
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
    <Dialog open={open} onOpenChange={setOpen}>
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
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o, claude-sonnet-5" />
          </div>
          <div className="space-y-1">
            <Label>System prompt</Label>
            <textarea
              className="min-h-32 w-full resize-y rounded-md border border-input bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Max tool calls per run</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={maxToolCalls}
              onChange={(e) => setMaxToolCalls(Number(e.target.value))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>Allowed tools: {agent.allowed_tools.join(", ") || "(none)"}</p>
            <p>Allowed hosts: {agent.allowed_hosts.join(", ") || "all"}</p>
            <p>Allowed environments: {agent.allowed_environments.join(", ") || "all"}</p>
          </div>
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

  const providerById = providers.reduce<Record<string, AIProvider>>((acc, p) => {
    acc[p.id] = p;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Agents</h1>
        {isAdmin && <AgentCreateDialog providers={providers} onCreated={refresh} />}
      </div>

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
                {p.kind !== "ollama" && <> - key {p.has_key ? "configured" : "not set"}</>}
              </p>
              {isAdmin && <ProviderKeyDialog provider={p} onSaved={refresh} />}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">{agent.name}</CardTitle>
              <Badge variant={STATUS_VARIANT[agent.status]}>{agent.status}</Badge>
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
              <div className="flex items-center gap-2 pt-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/ai-agents/chat?agent=${agent.slug}`}>
                    <MessageSquare className="h-3.5 w-3.5" />
                    Ask Agent
                  </Link>
                </Button>
                {isAdmin && <AgentConfigDialog agent={agent} providers={providers} onSaved={refresh} />}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
