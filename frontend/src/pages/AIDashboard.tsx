import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  Boxes,
  CheckCircle2,
  Clock,
  PlayCircle,
  Plus,
  Server,
  ShieldAlert,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { AIProviderUsageChart } from "@/components/ai/AIProviderUsageChart";
import { PendingApprovalsCard } from "@/components/ai/PendingApprovalsCard";
import { ToolProposalsCard } from "@/components/ai/ToolProposalsCard";
import { useAuth } from "@/lib/auth";
import { SystemLoadChart } from "@/components/ai/SystemLoadChart";
import { AgentFigure } from "@/components/ops-floor/AgentFigure";
import { FloorPlan } from "@/components/ops-floor/FloorPlan";
import { StatusGlyph } from "@/components/ops-floor/StatusGlyph";
import { activityRows, buildEdges, buildFloor, buildFlows, floorCounts, groupActivity, MOTION_LABEL, STATUS_LABEL, type FloorAgent } from "@/lib/opsFloor/model";
import { useOpsFloorData } from "@/lib/opsFloor/useOpsFloorData";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AIFinding, type AITask, type AgentStatus, type ContainerInfo, type Host, type SecuritySummary } from "@/lib/api";
import { severityVariant } from "@/lib/severity";
import { formatClock } from "@/lib/format";

const OFFLINE_AFTER_MS = 30 * 60 * 1000;

const STATUS_VARIANT: Record<AgentStatus, "ok" | "warning" | "critical" | "unknown" | "secondary"> = {
  idle: "secondary",
  working: "ok",
  waiting: "unknown",
  investigating: "ok",
  error: "critical",
  disabled: "unknown",
};

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function firstHostname(task: AITask): string | null {
  for (const t of task.tools_used) {
    const hostname = (t.arguments as Record<string, unknown> | undefined)?.hostname;
    if (typeof hostname === "string") return hostname;
  }
  return null;
}

const FLOOR_VARIANT = { working: "ok", idle: "unknown", paused: "unknown", approval: "warning", error: "critical" } as const;
const STRIP_ORDER = { working: 0, approval: 1, error: 2, idle: 3, paused: 4 } as const;

/**
 * Only agents that need attention or are at work: working, waiting for an
 * approval, or failed. The rest is one short line; the floor below shows everyone.
 */
function AgentStrip({ agents, onOpen }: { agents: FloorAgent[]; onOpen: (slug: string) => void }) {
  const active = agents.filter((agent) => agent.status === "working" || agent.status === "approval" || agent.status === "error")
    .sort((a, b) => STRIP_ORDER[a.status] - STRIP_ORDER[b.status] || a.name.localeCompare(b.name));
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const paused = agents.filter((agent) => agent.status === "paused").length;
  const rest = [idle && `${idle} idle`, paused && `${paused} paused`].filter(Boolean).join(" · ");
  return (
    <div className="mb-3 space-y-1.5">
      {active.length === 0
        ? <p className="text-xs text-muted-foreground">No agent is working right now{rest ? ` · ${rest}` : ""}.</p>
        : (
          <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Agents at work">
            {active.map((agent) => {
              const label = agent.status === "working" && agent.motion !== "busy" ? MOTION_LABEL[agent.motion] : STATUS_LABEL[agent.status];
              const tone = agent.status === "working" ? "of-strip-working border-primary/50 bg-primary/10"
                : agent.status === "approval" ? "border-status-warning/50 bg-status-warning/10" : "border-status-critical/50 bg-status-critical/10";
              return (
                <li key={agent.slug} className="min-w-0">
                  <button type="button" onClick={() => onOpen(agent.slug)} title={[agent.name, label, agent.task].filter(Boolean).join(" · ")}
                    aria-label={`${agent.name}: ${label}${agent.runningTasks > 1 ? `, ${agent.runningTasks} tasks` : ""}${agent.task ? `. ${agent.task}` : ""}`}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tone}`}>
                    <span className="relative shrink-0">
                      <AgentFigure slug={agent.slug} size={22} />
                      {agent.status === "working" && <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2" aria-hidden="true">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" /></span>}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{agent.name}</span>
                      <span className={`flex min-w-0 items-center gap-1 of-tx-${agent.status}`}><StatusGlyph status={agent.status} size={10} />
                        <span className="truncate">{label}{agent.runningTasks > 1 ? ` · ${agent.runningTasks} tasks` : ""}{agent.task ? ` · ${agent.task}` : ""}</span></span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      {active.length > 0 && rest && <p className="text-xs text-muted-foreground">Also {rest}, shown on the floor below.</p>}
    </div>
  );
}

export default function AIDashboard() {
  // The same agents, tasks, approvals and live stream as the Ops Floor: one source, no second status system.
  const data = useOpsFloorData();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const providers = data.providers;
  const agents = useMemo(() => data.configs ?? [], [data.configs]);
  const tasks = data.tasks;
  const pending = data.pending;

  const [findings, setFindings] = useState<AIFinding[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [securitySummary, setSecuritySummary] = useState<SecuritySummary | null>(null);

  useEffect(() => {
    function refresh() {
      api.ai.findings.list(20).then(setFindings).catch(() => {});
      api.hosts.list().then(setHosts).catch(() => {});
      api.containers.list().then(setContainers).catch(() => {});
      api.alerts
        .list()
        .then((res) => setAlertCount(res.available ? res.alerts.filter((a) => a.status.state === "active").length : null))
        .catch(() => setAlertCount(null));
      api.security.summary().then(setSecuritySummary).catch(() => {});
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  const providerById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const taskCountByAgent = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.agent_id] = (acc[t.agent_id] ?? 0) + 1;
    return acc;
  }, {});

  const kpis = {
    completedToday: tasks.filter((t) => t.status === "completed" && isToday(t.created_at)).length,
    pendingApprovals: pending.length,
    failedTasks: tasks.filter((t) => t.status === "failed").length,
  };
  const allOperational = !agents.some((a) => a.status === "error");
  const hostsOnline = hosts.filter((h) => h.last_seen && Date.now() - new Date(h.last_seen).getTime() < OFFLINE_AFTER_MS).length;
  const containersRunning = containers.filter((c) => c.status === "running").length;

  const floor = useMemo(() => buildFloor(agents, data.live, pending, tasks, data.now), [agents, data.live, pending, tasks, data.now]);
  const edges = useMemo(() => buildEdges(agents, tasks, floor.agents), [agents, tasks, floor.agents]);
  const flows = useMemo(() => buildFlows(floor.agents, data.live, data.now), [floor.agents, data.live, data.now]);
  const activity = useMemo(() => groupActivity(activityRows(data.liveRows, tasks, floor.agents, 300), 10), [data.liveRows, tasks, floor.agents]);
  // Counted per unique agent from the same model as the Ops Floor; tasks are counted separately.
  const counts = floorCounts(floor.agents, tasks);
  const openOnFloor = (slug: string) => navigate(`/ai-agents/ops-floor?agent=${encodeURIComponent(slug)}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight">AI overview</h1>
            <p className="text-xs text-muted-foreground">Deploy, monitor and collaborate with AI agents for your infrastructure.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={allOperational ? "ok" : "critical"}>{allOperational ? "All agents operational" : "Attention needed"}</Badge>
          <Button size="sm" asChild>
            <Link to="/ai-agents/agents">
              <Plus className="h-3.5 w-3.5" />
              New Agent
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Active Agents", value: counts.active, icon: Bot, color: "text-primary", live: counts.active > 0 },
          { label: "Running Tasks", value: counts.runningTasks, icon: PlayCircle, color: "text-primary", hint: counts.queued ? `${counts.queued} queued` : undefined },
          { label: "Idle Agents", value: counts.idle, icon: Bot, color: "text-muted-foreground" },
          { label: "Completed Today", value: kpis.completedToday, icon: CheckCircle2, color: "text-status-ok" },
          { label: "Pending Approvals", value: kpis.pendingApprovals, icon: Clock, color: "text-status-warning" },
          { label: "Failed Tasks", value: kpis.failedTasks, icon: AlertTriangle, color: "text-status-critical" },
        ].map(({ label, value, icon: Icon, color, live, hint }: { label: string; value: number | string; icon: typeof Bot; color: string; live?: boolean; hint?: string }) => (
          <Card key={label} data-kpi={label} className={live ? "border-primary/40" : undefined}>
            <CardContent className="flex items-center gap-2.5 p-3">
              <span className="relative shrink-0">
                <Icon className={`h-4 w-4 ${color}`} />
                {live && <span className="absolute -right-1 -top-1 flex h-2 w-2" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" /></span>}
              </span>
              <div className="min-w-0">
                <div className="text-lg font-semibold leading-none">{value}</div>
                <div className="truncate text-[11px] text-muted-foreground">{label}{hint ? <span className="text-muted-foreground/70"> · {hint}</span> : null}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <PendingApprovalsCard pending={pending} agents={agents} onChanged={data.refresh} />
      <ToolProposalsCard isAdmin={hasRole("admin")} openOnly />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Ops Floor</CardTitle>
            <p className="text-xs text-muted-foreground">Live view of your AI agents at work</p>
          </CardHeader>
          <CardContent className="px-2 pb-2 sm:px-4 sm:pb-4">
            <AgentStrip agents={floor.agents} onOpen={openOnFloor} />
            <div className="of-page of-embedded">
              <FloorPlan agents={floor.agents} layout={floor.layout} edges={edges} flows={flows} selected={null} isDim={() => false} onSelect={openOnFloor} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Live Activity</CardTitle>
            <p className="text-xs text-muted-foreground">See what your agents are doing now</p>
          </CardHeader>
          <CardContent className="of-tokens max-h-[26rem] space-y-2 overflow-y-auto text-sm">
            {activity.length === 0 && <p className="text-muted-foreground">No agent activity yet.</p>}
            {activity.map((entry) => (
              <div key={entry.id} className="border-b border-border pb-2 last:border-0">
                <button type="button" className="block w-full text-left hover:bg-accent/30" onClick={() => openOnFloor(entry.slug)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 font-medium"><AgentFigure slug={entry.slug} size={16} /><span className="truncate">{floor.agents.find((a) => a.slug === entry.slug)?.name ?? entry.slug}</span></span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatClock(entry.ts)}</span>
                  </div>
                  <p className={`flex items-center gap-1.5 text-xs text-muted-foreground of-tx-${entry.kind}`}><StatusGlyph status={entry.kind} size={10} /><span className="truncate text-muted-foreground">{entry.text}</span>
                    {entry.count > 1 && <span className="ml-auto shrink-0 rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-foreground">×{entry.count}</span>}</p>
                </button>
                {entry.count > 1 && (
                  <details className="mt-1 text-[11px] text-muted-foreground">
                    <summary className="cursor-pointer truncate hover:text-foreground">{entry.tally.map(([step, n]) => `${step} ×${n}`).join(" · ")}</summary>
                    <ol className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                      {entry.rows.map((row) => <li key={row.id} className="flex gap-2"><span className="shrink-0 tabular-nums">{formatClock(row.ts)}</span><span className="truncate">{row.text}</span></li>)}
                    </ol>
                  </details>
                )}
              </div>
            ))}
            <Link to="/ai-agents/agent-logs" className="block pt-1 text-xs text-primary hover:underline">
              View all activity →
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-base">Task Overview</CardTitle>
              <p className="text-xs text-muted-foreground">Current and recent agent tasks</p>
            </div>
            <Link to="/ai-agents/tasks" className="text-xs text-primary hover:underline">
              View all tasks →
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="ops-card-table w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Task</th>
                    <th className="px-3 py-2 font-medium">Agent</th>
                    <th className="px-3 py-2 font-medium">Target</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No tasks yet.
                      </td>
                    </tr>
                  )}
                  {tasks.slice(0, 6).map((t) => (
                    <tr key={t.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                      <td data-label="Task" className="max-w-[10rem] truncate px-3 py-2">{t.input_message}</td>
                      <td data-label="Agent" className="px-3 py-2 text-muted-foreground">{agents.find((a) => a.id === t.agent_id)?.name ?? "-"}</td>
                      <td data-label="Target" className="px-3 py-2 text-muted-foreground">{firstHostname(t) ?? "-"}</td>
                      <td data-label="Status" className="px-3 py-2">
                        <Badge variant={t.status === "failed" ? "critical" : t.status === "completed" ? "ok" : "unknown"}>
                          {t.status}
                        </Badge>
                      </td>
                      <td data-label="Started" className="px-3 py-2 text-muted-foreground">{timeAgo(t.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <div>
              <CardTitle className="text-base">Agent Health</CardTitle>
              <p className="text-xs text-muted-foreground">Status of all AI agents</p>
            </div>
            <Link to="/ai-agents/agents" className="text-xs text-primary hover:underline">
              View all agents →
            </Link>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="ops-card-table w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Agent</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => {
                    const onFloor = floor.agents.find((a) => a.id === agent.id);
                    return (
                    <tr key={agent.id} className="border-b border-border last:border-0">
                      <td data-label="Agent" className="px-3 py-2"><span className="flex items-center gap-2"><AgentFigure slug={agent.slug} size={18} />{agent.name}</span></td>
                      <td data-label="Status" className="px-3 py-2">
                        {/* The same status as the Ops Floor: running tasks decide "working", not the last write to the agent row. */}
                        <Badge variant={onFloor ? FLOOR_VARIANT[onFloor.status] : STATUS_VARIANT[agent.status]}>{onFloor ? STATUS_LABEL[onFloor.status] : agent.status}</Badge>
                        {onFloor && onFloor.runningTasks > 1 && <span className="ml-1.5 text-xs text-muted-foreground">{onFloor.runningTasks} tasks</span>}
                      </td>
                      <td data-label="Model" className="px-3 py-2 text-muted-foreground">
                        {agent.model || providerById[agent.provider_id ?? ""]?.default_model || "-"}
                      </td>
                      <td data-label="Tasks" className="px-3 py-2 text-muted-foreground">{taskCountByAgent[agent.id] ?? 0}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle className="text-base">Infrastructure Overview</CardTitle>
                <p className="text-xs text-muted-foreground">Live status from Ops Center</p>
              </div>
              <Link to="/servers" className="text-xs text-primary hover:underline">
                Open in Ops Center →
              </Link>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Servers", value: `${hostsOnline}/${hosts.length}`, sub: "Online", icon: Server },
                { label: "Containers", value: containersRunning, sub: "Running", icon: Boxes },
                { label: "Active Alerts", value: alertCount ?? "-", sub: securitySummary ? "" : "", icon: Bell },
                { label: "Vulnerabilities", value: securitySummary?.critical ?? "-", sub: "Critical", icon: ShieldAlert },
              ].map(({ label, value, sub, icon: Icon }) => (
                <div key={label} className="rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </div>
                  <div className="text-lg font-semibold leading-tight">{value}</div>
                  {sub && <div className="text-[11px] text-status-ok">{sub}</div>}
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">System Load (Last 24h)</CardTitle>
            </CardHeader>
            <CardContent>
              <SystemLoadChart />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">AI Provider Usage</CardTitle>
              <p className="text-xs text-muted-foreground">Token usage (last 7 days)</p>
            </CardHeader>
            <CardContent>
              <AIProviderUsageChart />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <div>
                <CardTitle className="text-base">Recent Findings</CardTitle>
                <p className="text-xs text-muted-foreground">Important findings from your agents</p>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="ops-card-table w-full text-sm">
                  <tbody>
                    {findings.length === 0 && (
                      <tr>
                        <td className="px-3 py-6 text-center text-muted-foreground">No findings yet.</td>
                      </tr>
                    )}
                    {findings.slice(0, 5).map((f) => (
                      <tr key={f.id} className="border-b border-border last:border-0">
                        <td className="w-20 px-3 py-2">
                          <Badge variant={severityVariant(f.severity)}>{f.severity}</Badge>
                        </td>
                        <td className="px-3 py-2">{f.title}</td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">{timeAgo(f.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

    </div>
  );
}
