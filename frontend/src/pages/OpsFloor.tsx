import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { OpsFloorActivityPanel } from "@/components/ops-floor/OpsFloorActivityPanel";
import { OpsFloorAgentPanel } from "@/components/ops-floor/OpsFloorAgentPanel";
import { OpsFloorView } from "@/components/ops-floor/OpsFloorView";
import { api, fetchHealth, type AIAction, type AIAgent, type AIProvider, type AITask } from "@/lib/api";
import { useOpsFloorAgents } from "@/lib/opsFloorEvents";
import { useAgentActivityFeed } from "@/lib/useAgentActivityFeed";
import type { AgentVisual } from "@/lib/opsFloorTypes";

const REFRESH_MS = 15000;

function StatusIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="#00D9FF" strokeWidth="1.6">
      <path d="M15 2 27 9v13l-12 7L3 22V9Zm0 13L3 9m12 6L27 9M15 15v14" />
    </svg>
  );
}

function StatDivider() {
  return <span className="h-4 w-px shrink-0" style={{ background: "#23384D" }} />;
}

function StatPill({ dot, label }: { dot: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot, boxShadow: `0 0 4px ${dot}` }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: "#D7E2ED" }}>{label}</span>
    </div>
  );
}

export default function OpsFloor() {
  const { agents: floorAgents, connected } = useOpsFloorAgents();
  const activity = useAgentActivityFeed();
  const [selectedSlug, setSelectedSlug] = useState<string | null>("linux");

  const [agentConfigs, setAgentConfigs] = useState<AIAgent[]>([]);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [pendingActions, setPendingActions] = useState<AIAction[]>([]);
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [stopping, setStopping] = useState(false);
  const [queuedTasks, setQueuedTasks] = useState(0);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const [pausingId, setPausingId] = useState<string | null>(null);

  useEffect(() => {
    function refresh() {
      api.ai.agents.list().then(setAgentConfigs).catch(() => {});
      api.ai.providers.list().then(setProviders).catch(() => {});
      api.ai.actions.list("pending", 100).then(setPendingActions).catch(() => {});
      api.ai.tasks.list(100).then((tasks) => { setTasks(tasks); setQueuedTasks(tasks.filter((t) => t.status === "queued").length); }).catch(() => {});
      fetchHealth()
        .then((h) => setApiHealthy(h.status === "ok"))
        .catch(() => setApiHealthy(false));
    }
    refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function handleTogglePause(agent: AIAgent) {
    setPausingId(agent.id);
    try {
      const updated = await api.ai.agents.update(agent.id, { enabled: !agent.enabled });
      setAgentConfigs((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } catch {
      /* toast system already surfaces the failure via apiSend */
    } finally {
      setPausingId(null);
    }
  }

  const selected: AgentVisual | undefined = floorAgents.find((a) => a.slug === selectedSlug);
  const selectedDetail = agentConfigs.find((a) => a.slug === selectedSlug) ?? null;
  const selectedTask = tasks.find(t => t.id === selected?.taskId) ?? tasks.find(t => t.agent_id === selectedDetail?.id && (t.status === "running" || t.status === "queued")) ?? null;
  async function stopSelectedTask() {
    if (!selectedTask) return;
    setStopping(true);
    try { const updated = await api.ai.tasks.cancel(selectedTask.id); setTasks(prev => prev.map(t => t.id === updated.id ? updated : t)); }
    finally { setStopping(false); }
  }
  const pendingForSelected = selectedDetail ? pendingActions.filter((a) => a.agent_id === selectedDetail.id).length : 0;

  const onlineCount = floorAgents.filter((a) => a.slug !== "coordinator" && connected && agentConfigs.find((c) => c.slug === a.slug)?.enabled === true).length;
  const workingCount = floorAgents.filter((a) => a.state === "working" || a.state === "investigating").length;
  const queuedCount = queuedTasks;
  const errorCount = floorAgents.filter((a) => a.state === "error").length;
  const allOperational = connected && errorCount === 0 && apiHealthy === true;

  return (
    // Negative margin escapes the shared app shell's own content padding
    // (Layout.tsx's `container py-6`) so this page can use the design
    // contract's exact 12px outer padding instead of inheriting a
    // different one - the app's persistent sidebar/header chrome around
    // this page is otherwise untouched (out of scope: every other page
    // uses it too).
    <div className="ops-floor-page">
      <div className="ops-floor-header">
        <div className="flex items-center gap-3">
          <StatusIcon />
          <div>
            <Link to="/ai-agents" style={{ fontSize: 25, fontWeight: 700, color: "#F3F7FB", lineHeight: 1.2 }} className="block hover:opacity-90">
              Ops Floor
            </Link>
            <p style={{ fontSize: 13, fontWeight: 400, color: "#8799AD" }}>Live view of your AI agents at work</p>
          </div>
        </div>

        <div
          className="ops-floor-counters"
          style={{ height: 42, background: "#0B121C", border: "1px solid #1C2D40", borderRadius: 9 }}
        >
          <StatPill dot="#20E69A" label={`${onlineCount} Agents Online`} />
          <StatDivider />
          <StatPill dot="#268CFF" label={`${workingCount} Working`} />
          <StatDivider />
          <StatPill dot="#FFC247" label={`${queuedCount} Tasks Queued`} />
          <StatDivider />
          <StatPill dot={errorCount > 0 ? "#FF4D67" : "#586A7D"} label={`${errorCount} Errors`} />
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p style={{ fontSize: 14, fontWeight: 700, color: "#F3F7FB" }}>Ops Center</p>
            <p style={{ fontSize: 11, color: "#8799AD" }}>AI Agents. Real Operations.</p>
          </div>
          <div className="flex items-center justify-center rounded-full" style={{ width: 34, height: 34, background: "#1A304B", color: "#DCE8F5", fontSize: 12, fontWeight: 700 }}>
            XN
          </div>
        </div>
      </div>

      <div className="ops-floor-main">
        <OpsFloorView agents={floorAgents} onSelect={(a) => setSelectedSlug(a.slug)} variant="full" selectedSlug={selectedSlug} />

        <div className="ops-floor-sidebar">
          <OpsFloorAgentPanel
            task={selectedTask}
            onStop={() => { void stopSelectedTask().catch(() => {}); }}
            stopping={stopping}
            agent={selected ?? null}
            detail={selectedDetail}
            providers={providers}
            pendingApprovals={pendingForSelected}
            onTogglePause={handleTogglePause}
            pausing={pausingId !== null && pausingId === selectedDetail?.id}
          />
          <OpsFloorActivityPanel entries={activity} />
        </div>
      </div>

      <div
        className="ops-floor-footer"
        style={{ height: 30, background: "#07101A", borderTop: "1px solid #172638", fontSize: 11, color: "#8799AD" }}
      >
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: allOperational ? "#20E69A" : "#FF4D67" }} />
          {allOperational ? "All systems operational" : "Attention needed"}
          {!connected && <span className="ml-1">· reconnecting…</span>}
        </div>
        <div className="flex items-center gap-3">
          <span>Ops Center</span>
          <span>{onlineCount} agents online</span>
          <span>{apiHealthy === null ? "Connecting" : apiHealthy === false ? "API degraded" : "API healthy"}</span>
          <span className="ops-floor-motto">⌁ &nbsp; Building more capable operations.</span>
        </div>
      </div>
    </div>
  );
}
