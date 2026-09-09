import { useEffect, useState } from "react";
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
import { Link } from "react-router-dom";

import { AIProviderUsageChart } from "@/components/ai/AIProviderUsageChart";
import { SystemLoadChart } from "@/components/ai/SystemLoadChart";
import { AgentPanel } from "@/components/ops-floor/AgentPanel";
import { OpsFloorView } from "@/components/ops-floor/OpsFloorView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOpsFloorAgents } from "@/lib/opsFloorEvents";
import { useAgentActivityFeed } from "@/lib/useAgentActivityFeed";
import {
  api,
  type AgentStatus,
  type AIAction,
  type AIAgent,
  type AIFinding,
  type AIProvider,
  type AITask,
  type ContainerInfo,
  type Host,
  type SecuritySummary,
} from "@/lib/api";

const OFFLINE_AFTER_MS = 30 * 60 * 1000;

const STATUS_VARIANT: Record<AgentStatus, "ok" | "warning" | "critical" | "unknown" | "secondary"> = {
  idle: "secondary",
  working: "ok",
  waiting: "unknown",
  investigating: "ok",
  error: "critical",
  disabled: "unknown",
};

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  info: "unknown",
  low: "unknown",
  medium: "warning",
  high: "warning",
  critical: "critical",
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

export default function AIDashboard() {
  const { agents: floorAgents } = useOpsFloorAgents();
  const activity = useAgentActivityFeed();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [findings, setFindings] = useState<AIFinding[]>([]);
  const [actions, setActions] = useState<AIAction[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [securitySummary, setSecuritySummary] = useState<SecuritySummary | null>(null);

  useEffect(() => {
    function refresh() {
      api.ai.providers.list().then(setProviders).catch(() => {});
      api.ai.agents.list().then(setAgents).catch(() => {});
      api.ai.tasks.list(20).then(setTasks).catch(() => {});
      api.ai.findings.list(20).then(setFindings).catch(() => {});
      api.ai.actions.list(undefined, 20).then(setActions).catch(() => {});
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
    activeAgents: agents.filter((a) => a.enabled).length,
    runningTasks: tasks.filter((t) => t.status === "running" || t.status === "queued").length,
    completedToday: tasks.filter((t) => t.status === "completed" && isToday(t.created_at)).length,
    pendingApprovals: actions.filter((a) => a.status === "pending").length,
    failedTasks: tasks.filter((t) => t.status === "failed").length,
  };
  const allOperational = !agents.some((a) => a.status === "error");
  const hostsOnline = hosts.filter((h) => h.last_seen && Date.now() - new Date(h.last_seen).getTime() < OFFLINE_AFTER_MS).length;
  const containersRunning = containers.filter((c) => c.status === "running").length;

  const selectedAgent = floorAgents.find((a) => a.slug === selectedSlug);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight">AI Agent Control Center</h1>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Active Agents", value: kpis.activeAgents, icon: Bot, color: "text-primary" },
          { label: "Running Tasks", value: kpis.runningTasks, icon: PlayCircle, color: "text-primary" },
          { label: "Completed Today", value: kpis.completedToday, icon: CheckCircle2, color: "text-status-ok" },
          { label: "Pending Approvals", value: kpis.pendingApprovals, icon: Clock, color: "text-status-warning" },
          { label: "Failed Tasks", value: kpis.failedTasks, icon: AlertTriangle, color: "text-status-critical" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-2.5 p-3">
              <Icon className={`h-4 w-4 shrink-0 ${color}`} />
              <div className="min-w-0">
                <div className="text-lg font-semibold leading-none">{value}</div>
                <div className="truncate text-[11px] text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Ops Floor</CardTitle>
            <p className="text-xs text-muted-foreground">Live view of your AI agents at work</p>
          </CardHeader>
          <CardContent className="px-2 pb-2 sm:px-4 sm:pb-4">
            <OpsFloorView agents={floorAgents} onSelect={(a) => setSelectedSlug(a.slug)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Live Activity</CardTitle>
            <p className="text-xs text-muted-foreground">See what your agents are doing now</p>
          </CardHeader>
          <CardContent className="max-h-[26rem] space-y-2 overflow-y-auto text-sm">
            {activity.length === 0 && <p className="text-muted-foreground">No agent activity yet.</p>}
            {activity.map((entry) => (
              <div key={entry.id} className="border-b border-border pb-2 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{entry.agent}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{entry.activity || entry.status}</p>
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
              <table className="w-full text-sm">
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
                      <td className="max-w-[10rem] truncate px-3 py-2">{t.input_message}</td>
                      <td className="px-3 py-2 text-muted-foreground">{agents.find((a) => a.id === t.agent_id)?.name ?? "-"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{firstHostname(t) ?? "-"}</td>
                      <td className="px-3 py-2">
                        <Badge variant={t.status === "failed" ? "critical" : t.status === "completed" ? "ok" : "unknown"}>
                          {t.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{timeAgo(t.created_at)}</td>
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
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Agent</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Tasks</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr key={agent.id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">{agent.name}</td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS_VARIANT[agent.status]}>{agent.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {agent.model || providerById[agent.provider_id ?? ""]?.default_model || "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{taskCountByAgent[agent.id] ?? 0}</td>
                    </tr>
                  ))}
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
                <table className="w-full text-sm">
                  <tbody>
                    {findings.length === 0 && (
                      <tr>
                        <td className="px-3 py-6 text-center text-muted-foreground">No findings yet.</td>
                      </tr>
                    )}
                    {findings.slice(0, 5).map((f) => (
                      <tr key={f.id} className="border-b border-border last:border-0">
                        <td className="w-20 px-3 py-2">
                          <Badge variant={SEVERITY_VARIANT[f.severity] ?? "unknown"}>{f.severity}</Badge>
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

      {selectedAgent && <AgentPanel agent={selectedAgent} onClose={() => setSelectedSlug(null)} />}
    </div>
  );
}
