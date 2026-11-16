import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minimize } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { ActivityLog } from "@/components/ops-floor/ActivityLog";
import { DetailPanel } from "@/components/ops-floor/DetailPanel";
import { FloorPlan, type FloorLink } from "@/components/ops-floor/FloorPlan";
import { StatusGlyph } from "@/components/ops-floor/StatusGlyph";
import { TaskDialog } from "@/components/ops-floor/TaskDialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { activityRows, buildEdges, buildFloor, buildFlows, floorCounts, groupActivity, matchesFilter, STATUS_LABEL, type FloorAgent, type FloorFilter, type FloorStatus } from "@/lib/opsFloor/model";
import { useOpsFloorData } from "@/lib/opsFloor/useOpsFloorData";

// The office is a lot of DOM, so it only loads when someone opens it.
const Office3D = lazy(() => import("@/components/ops-floor/Office3D").then((module) => ({ default: module.Office3D })));

const VIEW_KEY = "ops_floor_view";
const OLD_LAYOUT_KEY = "ops-floor-2d-layout-v3";
type View = "2d" | "3d";
const STATUSES: FloorStatus[] = ["paused", "idle", "working", "approval", "error"];
const FILTERS: [FloorFilter, string][] = [["all", "All"], ["needs", "Needs you"], ["working", "Working"], ["quiet", "Quiet"]];

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "3d" ? "3d" : "2d"; } catch { return "2d"; }
}

function Stat({ value, label, filter, current, onPick, tone, glyph }: {
  value: number; label: string; filter: FloorFilter; current: FloorFilter; onPick: (filter: FloorFilter) => void; tone?: "alert" | "warn" | "busy"; glyph?: FloorStatus;
}) {
  const pressed = current === filter;
  return (
    <button type="button" className={`of-stat${tone && value > 0 ? ` of-stat-${tone}` : ""}`} aria-pressed={pressed} title={pressed ? "Show all agents" : `Show only: ${label}`}
      onClick={() => onPick(pressed ? "all" : filter)}>
      <strong>{value}</strong><span>{glyph && <StatusGlyph status={glyph} />}{label}</span>
    </button>
  );
}

export default function OpsFloor() {
  const data = useOpsFloorData();
  const { hasRole } = useAuth();
  const [params] = useSearchParams();
  const [view, setView] = useState<View>(readView);
  const [filter, setFilter] = useState<FloorFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(() => params.get("agent"));
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  const floor = useMemo(() => buildFloor(data.configs ?? [], data.live, data.pending, data.tasks, data.now), [data.configs, data.live, data.pending, data.tasks, data.now]);
  const edges = useMemo(() => buildEdges(data.configs ?? [], data.tasks, floor.agents), [data.configs, data.tasks, floor.agents]);
  const flows = useMemo(() => buildFlows(floor.agents, data.live, data.now), [floor.agents, data.live, data.now]);
  const counts = floorCounts(floor.agents, data.tasks);
  const rows = useMemo(() => activityRows(data.liveRows, data.tasks, floor.agents, 300), [data.liveRows, data.tasks, floor.agents]);
  const groups = useMemo(() => groupActivity(rows, 40), [rows]);
  const isDim = useCallback((agent: FloorAgent) => !matchesFilter(agent, filter, search), [filter, search]);
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const agent of data.configs ?? []) { names.set(agent.slug, agent.name); names.set(agent.id, agent.name); }
    return (key: string) => names.get(key) ?? key;
  }, [data.configs]);

  // Picked once, so a new poll never moves the user's selection.
  useEffect(() => {
    if (selected || !floor.agents.length) return;
    const first = floor.agents.find((agent) => agent.status === "approval" || agent.status === "error") ?? floor.agents.find((agent) => agent.slug === "coordinator") ?? floor.agents[0];
    setSelected(first.slug);
  }, [floor.agents, selected]);

  // Seats are fixed now, so the old drag-and-drop layout has nothing left to do.
  useEffect(() => {
    try { localStorage.removeItem(OLD_LAYOUT_KEY); } catch { /* Nothing to clean up without storage. */ }
  }, []);

  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement);
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("fullscreenchange", changed); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  function chooseView(next: View) {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* The choice just lasts this visit. */ }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.current?.requestFullscreen?.().catch(() => {});
  }

  async function resumeAll() {
    setResuming(true);
    setResumeError(null);
    const results = await Promise.allSettled((data.configs ?? []).filter((agent) => !agent.enabled).map((agent) => api.ai.agents.update(agent.id, { enabled: true })));
    setResuming(false);
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) setResumeError(`${failed} agents could not be resumed.`);
    else setConfirmResume(false);
    void data.refresh();
  }

  // A line belongs to a task when a running task made it; otherwise it just points at the agent.
  const onLink = useCallback((link: FloorLink) => {
    setSelected(link.from);
    if (link.taskId) setOpenTask(link.taskId);
  }, []);

  const agent = floor.agents.find((item) => item.slug === selected) ?? null;
  const config = data.configs?.find((item) => item.slug === selected) ?? null;
  const agentRows = useMemo(() => rows.filter((row) => row.slug === selected), [rows, selected]);
  const history = useMemo(() => data.tasks.filter((task) => task.agent_id === agent?.id), [data.tasks, agent?.id]);
  const task = data.tasks.find((item) => item.id === openTask) ?? null;

  return (
    <div className="of-page" data-hidden={hidden ? "" : undefined}>
      <header className="of-head">
        <div>
          <nav aria-label="Breadcrumb" className="of-crumbs"><Link to="/">Ops Center</Link> / <Link to="/ai-agents">AI Agents</Link> / Ops Floor</nav>
          <h1>Ops Floor</h1>
        </div>
        <div className="of-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "2d"} onClick={() => chooseView("2d")}>2D Plan</button>
          <button type="button" aria-pressed={view === "3d"} onClick={() => chooseView("3d")}>3D Office</button>
        </div>
      </header>

      {counts.allPaused && (
        <div className="of-banner" role="status">
          <span>All agents are paused. They take no new tasks until they are resumed.</span>
          {hasRole("admin") && <Button variant="outline" className="min-h-11" onClick={() => { setResumeError(null); setConfirmResume(true); }}>Resume all agents</Button>}
        </div>
      )}
      {data.streamLost && data.configs && <p className="of-offline" role="status">Live updates are not connected. Status still refreshes every 15 seconds.</p>}
      {data.error && <p className="of-offline" role="alert">{data.configs ? `Could not refresh: ${data.error}. Showing the last known state.` : `Could not load the agents: ${data.error}`}</p>}

      <div className="of-stats" role="group" aria-label="Agent counts. Each one filters the floor.">
        <Stat value={counts.total} label="Total agents" filter="all" current={filter} onPick={setFilter} />
        <Stat value={counts.active} label="Active agents" filter="working" current={filter} onPick={setFilter} tone="busy" glyph="working" />
        <div className="of-stat" aria-label={`${counts.runningTasks} running tasks`}><strong>{counts.runningTasks}</strong><span>Running tasks</span></div>
        <Stat value={counts.idle} label="Idle" filter="idle" current={filter} onPick={setFilter} glyph="idle" />
        <Stat value={counts.approval} label="Needs approval" filter="approval" current={filter} onPick={setFilter} tone="warn" glyph="approval" />
        <Stat value={counts.errors} label="Errors" filter="error" current={filter} onPick={setFilter} tone="alert" glyph="error" />
        {counts.paused > 0 && <Stat value={counts.paused} label="Paused" filter="quiet" current={filter} onPick={setFilter} glyph="paused" />}
        {counts.queued > 0 && <div className="of-stat" aria-label={`${counts.queued} tasks queued`}><strong>{counts.queued}</strong><span>Queued tasks</span></div>}
      </div>

      <div className="of-layout">
        <div className="of-main">
          <section ref={stage} aria-label="Agents" className="of-panel of-stage-wrap">
            <div className="of-toolbar">
              <div className="of-seg" role="group" aria-label="Filter agents">
                {FILTERS.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
              </div>
              <div className="of-toolbar-right">
                <input className="of-search" type="text" aria-label="Search agents by name or skill" placeholder="Search name or skill…" value={search} onChange={(event) => setSearch(event.target.value)} />
                <button type="button" className="of-iconbtn" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
                  {fullscreen ? <Minimize className="h-4 w-4" aria-hidden="true" /> : <Maximize className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {!data.configs && !data.error && <p className="of-empty">Loading the floor…</p>}
            {data.configs && floor.agents.length === 0 && <p className="of-empty">No agents are configured yet.</p>}
            {floor.agents.length > 0 && (view === "2d"
              ? <FloorPlan agents={floor.agents} layout={floor.layout} edges={edges} flows={flows} selected={selected} isDim={isDim} onSelect={setSelected} onLink={onLink} />
              : <Suspense fallback={<p className="of-empty">Loading the office…</p>}><Office3D agents={floor.agents} layout={floor.layout} edges={edges} flows={flows} selected={selected} isDim={isDim} onSelect={setSelected} needs={counts.needs} working={counts.working} /></Suspense>)}

            <div className="of-legend">
              {STATUSES.map((status) => <span key={status} className={`of-status of-tx-${status}`}><StatusGlyph status={status} />{STATUS_LABEL[status]}</span>)}
              <span className="of-status of-tx-completed"><StatusGlyph status="idle" />Completed (briefly)</span>
              {view === "2d" && <span>Lines show work moving now. Select an agent to see its routes; click a line to open its task.</span>}
              {view === "3d" && <span>Drag to turn, Shift or right-drag to move, wheel to zoom, double-click an agent to focus.</span>}
            </div>
          </section>

          <ActivityLog groups={groups} agents={floor.agents} onSelect={setSelected} onOpenTask={setOpenTask} selected={selected} live={!data.streamLost} />
        </div>

        <DetailPanel agent={agent} config={config} providers={data.providers} hosts={data.hosts} onChanged={() => void data.refresh()}
          rows={agentRows} history={history} name={nameOf} onOpenTask={setOpenTask} onSelect={setSelected} />
      </div>

      <TaskDialog task={task} name={nameOf} onClose={() => setOpenTask(null)} />
      <ConfirmDialog open={confirmResume} title={`Resume all ${counts.paused} agents?`} confirmLabel="Resume all agents" busy={resuming} error={resumeError} onCancel={() => setConfirmResume(false)} onConfirm={() => void resumeAll()}>
        They start taking tasks again from chat, Talk and incident investigations.
      </ConfirmDialog>
    </div>
  );
}
