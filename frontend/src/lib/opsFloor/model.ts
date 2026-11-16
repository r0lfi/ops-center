import type { AIAction, AIAgent, AITask, AgentStatus } from "@/lib/api";

import { layoutFloor, type FloorLayout, type FloorSeat } from "./config";

/** The only statuses the floor knows. Both views and every count use these. */
export type FloorStatus = "paused" | "idle" | "working" | "approval" | "error";
export type FloorFilter = "all" | "needs" | "working" | "quiet" | "approval" | "error" | "idle";

export const STATUS_LABEL: Record<FloorStatus, string> = {
  paused: "Paused", idle: "Idle", working: "Working", approval: "Needs approval", error: "Error",
};

/** What the worker said just happened (worker_ai/ai/agent_state.py EVENTS). Null when it did not say. */
export type AgentEvent =
  | "task_started" | "tool_started" | "tool_finished" | "delegated" | "returned"
  | "approval_requested" | "action_started" | "action_finished" | "completed" | "stopped" | "error";

export interface LiveState {
  status: AgentStatus;
  activity: string | null;
  target: string | null;
  taskId: string | null;
  receivedAt: number;
  event?: AgentEvent | null;
  peer?: string | null;
  tool?: string | null;
}

/**
 * How an agent looks right now. Every value comes from a real event or the
 * saved status; "busy" means working with no event to say more.
 */
export type Motion =
  | "idle" | "paused" | "busy" | "starting" | "tool" | "thinking" | "delegating" | "reviewing"
  | "action" | "approval" | "error" | "completed";

export const MOTION_LABEL: Record<Motion, string> = {
  idle: "Idle", paused: "Paused", busy: "Working", starting: "Starting a task", tool: "Running a tool", thinking: "Thinking",
  delegating: "Delegating", reviewing: "Reviewing results", action: "Running an approved action", approval: "Needs approval",
  error: "Error", completed: "Completed",
};

/** A finished task shows as completed this long before the agent settles to idle. */
export const COMPLETED_MS = 5000;

export function motionOf(status: FloorStatus, live: LiveState | undefined, now: number): Motion {
  if (status === "error") return "error";
  if (status === "approval") return "approval";
  if (status === "paused") return "paused";
  if (status === "idle") return live?.event === "completed" && now - live.receivedAt < COMPLETED_MS ? "completed" : "idle";
  switch (live?.event) {
    case "task_started": return "starting";
    case "tool_started": return "tool";
    case "tool_finished": return "thinking";
    case "delegated": return "delegating";
    case "returned": return "reviewing";
    case "action_started": return "action";
    default: return "busy";
  }
}

/** What kind of screen a workstation shows while its agent works. */
export type ScreenKind = "terminal" | "code" | "security" | "dashboard" | "containers" | "patches" | "network" | "chat" | "docs";
const SCREEN: Record<string, ScreenKind> = {
  coordinator: "dashboard", monitoring: "dashboard", automation: "terminal", linux: "terminal", network: "network",
  container: "containers", security: "security", patching: "patches", chat: "chat", general: "docs", nova: "chat",
  "ext-coordinator": "dashboard", "ext-coder": "code", "ext-reader": "docs", "ext-reviewer": "code",
};
export const screenKind = (slug: string): ScreenKind => SCREEN[slug] ?? "terminal";

/**
 * Worst news first. "waiting" alone is not a request for approval, since an
 * agent also waits on the specialists it delegates to. A pending action, or
 * the worker saying so in the moment before that action is listed, is.
 */
export function floorStatus(input: { enabled: boolean; status: AgentStatus; pendingApprovals: number; activity?: string | null }): FloorStatus {
  if (input.status === "error") return "error";
  if (input.pendingApprovals > 0) return "approval";
  if (input.status === "waiting" && input.activity?.startsWith("Waiting for approval")) return "approval";
  if (!input.enabled || input.status === "disabled") return "paused";
  if (input.status === "working" || input.status === "investigating" || input.status === "waiting") return "working";
  return "idle";
}

export interface FloorAgent {
  id: string;
  slug: string;
  name: string;
  short: string;
  status: FloorStatus;
  motion: Motion;
  /** The agent it is handing work to or getting results from, if the worker said so. */
  peer: string | null;
  tool: string | null;
  task: string | null;
  target: string | null;
  role: string | null;
  skills: string[];
  enabled: boolean;
  /** Tasks this agent is running and has queued (backend open_task_counts). */
  runningTasks: number;
  queuedTasks: number;
  external: boolean;
  errorMessage: string | null;
  pending: AIAction[];
  currentTask: AITask | null;
  seat: FloorSeat;
  roomName: string;
}

export interface FloorState {
  agents: FloorAgent[];
  layout: FloorLayout;
}

const isOpen = (task: AITask) => task.status === "running" || task.status === "queued";

export function buildFloor(configs: AIAgent[], live: Record<string, LiveState>, pending: AIAction[], tasks: AITask[], time = Date.now()): FloorState {
  const layout = layoutFloor(configs.map((agent) => agent.slug));
  const roomName = Object.fromEntries(layout.rooms.map((room) => [room.id, room.name]));
  const agents = configs.map((config): FloorAgent => {
    const now = live[config.slug];
    const status = now?.status ?? config.status;
    const own = pending.filter((action) => action.agent_id === config.id);
    const runningTasks = config.running_tasks ?? 0;
    // Running tasks are authoritative: an agent with a task in progress is working,
    // even if its single saved status row was last written by another of its tasks.
    const base = floorStatus({ enabled: config.enabled, status, pendingApprovals: own.length, activity: now?.activity });
    const floor = base === "idle" && runningTasks > 0 ? "working" : base;
    const seat = layout.seats[config.slug];
    const currentTask = tasks.find((task) => task.id === now?.taskId) ?? tasks.find((task) => task.agent_id === config.id && isOpen(task)) ?? null;
    return {
      id: config.id,
      slug: config.slug,
      name: config.name,
      short: seat.short ?? config.name,
      status: floor,
      motion: motionOf(floor, now, time),
      peer: floor === "working" && (now?.event === "delegated" || now?.event === "returned") ? now.peer ?? null : null,
      tool: floor === "working" && now?.event === "tool_started" ? now.tool ?? null : null,
      task: floor === "paused" || floor === "idle" ? null : now?.activity ?? config.current_task ?? null,
      target: now?.target ?? null,
      role: config.responsibility ?? config.description,
      skills: config.allowed_tools,
      enabled: config.enabled,
      runningTasks,
      queuedTasks: config.queued_tasks ?? 0,
      external: config.runtime === "external",
      errorMessage: config.error_message,
      pending: own,
      currentTask,
      seat,
      roomName: roomName[seat.room] ?? seat.room,
    };
  });
  return { agents, layout };
}

/** Filters decide what is dimmed. They never move anyone. */
export function matchesFilter(agent: Pick<FloorAgent, "status" | "name" | "short" | "skills">, filter: FloorFilter, search: string) {
  const inFilter = filter === "all"
    || (filter === "needs" && (agent.status === "approval" || agent.status === "error"))
    || (filter === "working" && agent.status === "working")
    || (filter === "quiet" && (agent.status === "idle" || agent.status === "paused"))
    || (filter === "idle" && agent.status === "idle")
    || (filter === "approval" && agent.status === "approval")
    || (filter === "error" && agent.status === "error");
  if (!inFilter) return false;
  const text = `${agent.name} ${agent.short} ${agent.skills.join(" ")}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

export function floorCounts(agents: FloorAgent[], tasks: AITask[]) {
  const paused = agents.filter((agent) => !agent.enabled).length;
  return {
    needs: agents.filter((agent) => agent.status === "error").length + agents.reduce((sum, agent) => sum + agent.pending.length, 0),
    working: agents.filter((agent) => agent.status === "working").length,
    idle: agents.filter((agent) => agent.status === "idle").length,
    approval: agents.filter((agent) => agent.status === "approval").length,
    errors: agents.filter((agent) => agent.status === "error").length,
    queued: agents.some((agent) => agent.queuedTasks) ? agents.reduce((sum, agent) => sum + agent.queuedTasks, 0) : tasks.filter((task) => task.status === "queued").length,
    /** Unique agents at work, never one per task. */
    active: agents.filter((agent) => agent.status === "working").length,
    runningTasks: agents.reduce((sum, agent) => sum + agent.runningTasks, 0),
    paused,
    total: agents.length,
    allPaused: agents.length > 0 && paused === agents.length,
  };
}

export type EdgeTone = "dim" | "active" | "approval" | "error";
/** taskId is set when a running task made the link, so a click can show that task. */
export interface FloorEdge { from: string; to: string; tone: EdgeTone; taskId?: string }

/**
 * A line is either a delegation the configuration allows or one a task has
 * really made. Null targets on the Coordinator mean every enabled agent that
 * is not personal, and the opencode agents are never routed to from here.
 */
export function buildEdges(configs: AIAgent[], tasks: AITask[], agents: FloorAgent[]): FloorEdge[] {
  const bySlug = new Map(configs.map((config) => [config.slug, config]));
  const byId = new Map(configs.map((config) => [config.id, config]));
  const status = new Map(agents.map((agent) => [agent.slug, agent.status]));
  const pairs = new Set<string>();
  const add = (from: string, to: string) => { if (from !== to && bySlug.has(from) && bySlug.has(to)) pairs.add(`${from}\n${to}`); };

  for (const config of configs) {
    const targets = config.allowed_dispatch_targets
      ?? (config.slug === "coordinator" ? configs.filter((other) => other.enabled && !other.personal && other.runtime !== "external").map((other) => other.slug) : []);
    for (const target of targets) add(config.slug, target);
  }
  const running = new Map<string, string>();
  for (const task of tasks.filter((item) => item.status === "running")) {
    const from = byId.get(task.agent_id)?.slug;
    if (!from) continue;
    for (const to of task.agents_used) { add(from, to); running.set(`${from}\n${to}`, task.id); }
  }

  return [...pairs].map((pair) => {
    const [from, to] = pair.split("\n");
    const toStatus = status.get(to);
    const tone: EdgeTone = toStatus === "error" ? "error" : toStatus === "approval" ? "approval" : running.has(pair) ? "active" : "dim";
    const taskId = running.get(pair);
    return taskId ? { from, to, tone, taskId } : { from, to, tone };
  });
}

/**
 * Work moving between two agents right now: a delegation on its way out, or
 * results on their way back. Only from events the worker published.
 */
export interface FloorFlow { from: string; to: string; kind: "delegate" | "return"; taskId: string | null }

export function buildFlows(agents: FloorAgent[], live: Record<string, LiveState>, now = Date.now()): FloorFlow[] {
  const known = new Set(agents.map((agent) => agent.slug));
  const flows: FloorFlow[] = [];
  for (const agent of agents) {
    const state = live[agent.slug];
    if (!state?.peer || !known.has(state.peer) || agent.status !== "working") continue;
    if (state.event === "delegated") flows.push({ from: agent.slug, to: state.peer, kind: "delegate", taskId: state.taskId });
    else if (state.event === "returned" && now - state.receivedAt < COMPLETED_MS) flows.push({ from: state.peer, to: agent.slug, kind: "return", taskId: state.taskId });
  }
  return flows;
}

export interface ActivityRow { id: string; ts: number; slug: string; kind: FloorStatus; text: string; taskId?: string | null; peer?: string | null }

const LIVE_KIND: Record<AgentStatus, FloorStatus> = { idle: "idle", working: "working", investigating: "working", waiting: "working", error: "error", disabled: "paused" };

export interface LiveRow {
  id: string; ts: number; slug: string; status: AgentStatus; activity: string | null; target: string | null;
  event?: AgentEvent | null; peer?: string | null; tool?: string | null; taskId?: string | null;
}

/** One readable line for an event. Names come from the caller, so the model needs no agent registry. */
function eventText(row: LiveRow, name: (slug: string) => string): string | null {
  const peer = row.peer ? name(row.peer) : "another agent";
  switch (row.event) {
    case "task_started": return "Started a task";
    case "tool_started": return `Running ${row.tool ?? "a tool"}${row.target ? ` on ${row.target}` : ""}`;
    case "tool_finished": return "Analysing results";
    case "delegated": return `Handed work to ${peer}`;
    case "returned": return `Got results from ${peer}`;
    case "approval_requested": return `Needs approval: ${row.activity?.replace(/^Waiting for approval:\s*/, "") ?? "an action"}`;
    case "action_started": return row.activity ?? "Running an approved action";
    case "action_finished": return "Finished an approved action";
    case "completed": return "Completed its work";
    case "stopped": return row.activity ? `Stopped: ${row.activity}` : "Stopped";
    case "error": return row.activity ? `Error: ${row.activity}` : "Error";
    default: return null;
  }
}

const TASK_WORD: Partial<Record<AITask["status"], [FloorStatus, string]>> = {
  running: ["working", "Started a task"], failed: ["error", "A task failed"], completed: ["idle", "Finished a task"],
};

/**
 * Saved tasks give the log a past, so it is not empty until the next event
 * arrives. They only say that something happened. This page is shared, and a
 * task's text can be the words of someone's personal agent, which the worker
 * deliberately keeps out of the live stream.
 */
export function activityRows(live: LiveRow[], tasks: AITask[], agents: { id: string; slug: string; short?: string }[], limit = 40): ActivityRow[] {
  const slugOf = new Map(agents.map((agent) => [agent.id, agent.slug]));
  const shortOf = new Map(agents.map((agent) => [agent.slug, agent.short ?? agent.slug]));
  const name = (slug: string) => shortOf.get(slug) ?? slug;
  const fromLive = live.flatMap((row): ActivityRow[] => {
    const described = eventText(row, name);
    if (!described && (row.status === "idle" || !row.activity || row.activity === "Idle")) return [];
    const kind: FloorStatus = row.event === "approval_requested" || row.activity?.startsWith("Waiting for approval") ? "approval"
      : row.event === "completed" || row.event === "action_finished" ? "idle" : LIVE_KIND[row.status];
    const text = described ?? (row.target ? `${row.activity} · ${row.target}` : row.activity ?? "");
    return [{ id: row.id, ts: row.ts, slug: row.slug, kind, text, taskId: row.taskId ?? null, peer: row.peer ?? null }];
  });
  const fromTasks = tasks.flatMap((task): ActivityRow[] => {
    const word = TASK_WORD[task.status];
    const slug = slugOf.get(task.agent_id);
    const when = task.completed_at ?? task.started_at;
    if (!word || !slug || !when) return [];
    return [{ id: `task-${task.id}-${task.status}`, ts: new Date(when).getTime(), slug, kind: word[0], text: word[1], taskId: task.id }];
  });
  // A task's start or finish already arrived live: the saved task must not repeat it.
  const liveSaid = new Set(fromLive.filter((row) => row.taskId).map((row) => `${row.taskId}|${row.text}`));
  const said = (row: ActivityRow) => liveSaid.has(`${row.taskId}|${row.text === "Finished a task" ? "Completed its work" : row.text}`);
  return [...fromLive, ...fromTasks.filter((row) => !said(row))].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** Repeated activity of one agent on one task, folded into one line. */
export interface ActivityGroup {
  id: string; slug: string; taskId: string | null; kind: FloorStatus; text: string; ts: number; peer?: string | null;
  count: number;
  /** How often each step happened, most frequent first. */
  tally: [string, number][];
  rows: ActivityRow[];
}

/**
 * One group per agent and task (or per agent and text when there is no task),
 * newest first. The newest event gives the group its text, status and time;
 * every event stays in rows, so nothing is lost.
 */
export function groupActivity(rows: ActivityRow[], limit = 40): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const row of [...rows].sort((a, b) => b.ts - a.ts)) {
    const key = `${row.slug}|${row.taskId ?? `text:${row.text}`}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { id: `group-${row.id}`, slug: row.slug, taskId: row.taskId ?? null, kind: row.kind, text: row.text, ts: row.ts, peer: row.peer, count: 1, tally: [], rows: [row] });
    } else {
      group.count += 1;
      group.rows.push(row);
    }
  }
  // Then single events with the same text from the same agent in a row (twelve
  // tasks that each "Started a task") become one line; each task stays listed.
  const folded: ActivityGroup[] = [];
  for (const group of groups.values()) {
    const last = folded[folded.length - 1];
    const single = group.count === 1;
    if (last && single && last.slug === group.slug && last.text === group.text && last.rows.every((row) => row.text === group.text)) {
      last.count += 1;
      last.rows.push(...group.rows);
      if (last.taskId !== group.taskId) last.taskId = null;
    } else {
      folded.push({ ...group, rows: [...group.rows] });
    }
  }
  for (const group of folded) {
    const counts = new Map<string, number>();
    for (const row of group.rows) {
      const step = row.text.startsWith("Running ") ? row.text.split(" on ")[0] : row.text;
      counts.set(step, (counts.get(step) ?? 0) + 1);
    }
    group.tally = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }
  return folded.slice(0, limit);
}
