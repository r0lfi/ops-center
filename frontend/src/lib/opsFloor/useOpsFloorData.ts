import { useCallback, useEffect, useRef, useState } from "react";

import { api, type AIAction, type AIAgent, type AIProvider, type AITask, type AgentStatus, type Host } from "@/lib/api";
import { useSessionToken } from "@/lib/auth";

import { COMPLETED_MS, type AgentEvent, type LiveRow, type LiveState } from "./model";

const REFRESH_MS = 15000;
const MAX_LIVE_ROWS = 60;

interface StreamMessage {
  agent?: string; status: AgentStatus; activity: string | null; target: string | null; task_id: string | null; ts?: number;
  event?: AgentEvent | null; peer?: string | null; tool?: string | null;
}

/**
 * The saved state from the API, with the live stream layered on top of it.
 * The one data source for the 2D plan, the 3D office and the AI overview.
 */
export function useOpsFloorData() {
  const token = useSessionToken();
  const [configs, setConfigs] = useState<AIAgent[] | null>(null);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [pending, setPending] = useState<AIAction[]>([]);
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [liveRows, setLiveRows] = useState<LiveRow[]>([]);
  const [streamLost, setStreamLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Short-lived looks (completed, results returned) end on a timer, not on the next event.
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const startedAt = Date.now();
    try {
      const [agents, actions, recent] = await Promise.all([api.ai.agents.list(), api.ai.actions.list("pending", 100), api.ai.tasks.list(100)]);
      setConfigs(agents);
      setPending(actions);
      setTasks(recent);
      setError(null);
      // The API answer is newer than any event that arrived before it was asked for.
      setLive((previous) => Object.fromEntries(Object.entries(previous).filter(([, state]) => state.receivedAt >= startedAt)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the agents");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    api.ai.providers.list().then(setProviders).catch(() => {});
    api.hosts.list().then(setHosts).catch(() => {});
    // A hidden tab does not poll; it catches up as soon as it is shown again.
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, REFRESH_MS);
    const shown = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", shown);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", shown); };
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    const source = new EventSource(`/api/ai/agents/stream?token=${encodeURIComponent(token)}`);
    let lost = false;
    source.onopen = () => {
      setStreamLost(false);
      // Events may have been missed while disconnected; the stream replays state, the API the rest.
      if (lost) void refresh();
      lost = false;
    };
    source.onerror = () => { lost = true; setStreamLost(true); };
    source.onmessage = (message) => {
      let data: StreamMessage;
      try { data = JSON.parse(message.data); } catch { return; }
      if (!data.agent) return;
      const slug = data.agent;
      const receivedAt = Date.now();
      const extra = { event: data.event ?? null, peer: data.peer ?? null, tool: data.tool ?? null };
      setLive((previous) => ({ ...previous, [slug]: { status: data.status, activity: data.activity, target: data.target, taskId: data.task_id, receivedAt, ...extra } }));
      setNow(receivedAt);
      // On connect the stream replays each agent's saved state, with no time on it. That is not something that just happened.
      if (typeof data.ts !== "number") return;
      const ts = data.ts * 1000;
      setLiveRows((previous) => [{ id: `${slug}-${receivedAt}-${previous.length}`, ts, slug, status: data.status, activity: data.activity, target: data.target, taskId: data.task_id, ...extra }, ...previous].slice(0, MAX_LIVE_ROWS));
      if (data.event === "completed" || data.event === "returned") void refresh();
    };
    return () => source.close();
  }, [token, refresh]);

  // Wake once when the newest short-lived look expires, so nothing stays "Completed" forever.
  useEffect(() => {
    const expiries = Object.values(live)
      .filter((state) => state.event === "completed" || state.event === "returned")
      .map((state) => state.receivedAt + COMPLETED_MS - now)
      .filter((left) => left > 0);
    if (!expiries.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...expiries) + 50);
    return () => clearTimeout(timer);
  }, [live, now]);

  return { configs, providers, pending, tasks, hosts, live, liveRows, streamLost, error, refresh, now };
}
