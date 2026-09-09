import { useEffect, useState } from "react";

import { getToken, type AgentStatus } from "@/lib/api";
import { REAL_AGENT_SLUGS, STATIONS, stationBySlug, type AgentVisual, type AgentVisualState } from "@/lib/opsFloorTypes";

/**
 * Live driver for the Ops Floor - subscribes to /api/ai/agents/stream
 * (SSE, published by worker_ai/events.py every time
 * agent_state.set_agent_state runs on the backend, for both a directly-
 * asked agent and any specialist a Coordinator delegates to).
 *
 * War Room membership is a client-side rule, not a backend "investigation"
 * record (none exists yet): if 2+ real agents are simultaneously non-idle,
 * every non-idle specialist animates into a slot ringed around the
 * hologram table (the Coordinator no longer has its own robot - it *is*
 * the table now, see OpsFloorScene.tsx) - a visual "reporting in" to the
 * Coordinator; otherwise it stays at its own desk.
 */

const GATHER_SLOTS: Record<string, { x: number; y: number }> = {
  linux: { x: 38, y: 62 },
  monitoring: { x: 58, y: 62 },
  general: { x: 48, y: 72 },
  container: { x: 34, y: 54 },
  security: { x: 62, y: 54 },
  patching: { x: 66, y: 62 },
  network: { x: 40, y: 50 },
  automation: { x: 56, y: 50 },
  chat: { x: 48, y: 44 },
};

interface AgentEventPayload {
  agent: string;
  status: AgentStatus;
  activity: string | null;
  target: string | null;
  task_id: string | null;
}

function toVisualState(status: AgentStatus): AgentVisualState {
  return status === "disabled" ? "idle" : status;
}

function initialAgents(): Record<string, AgentVisual> {
  const agents: Record<string, AgentVisual> = {};
  for (const slug of REAL_AGENT_SLUGS) {
    const station = stationBySlug(slug);
    if (!station) continue;
    agents[slug] = {
      slug,
      name: station.label,
      color: station.color,
      home: { x: station.x, y: station.y },
      position: { x: station.x, y: station.y },
      state: "idle",
      activity: "Idle",
      target: null,
    };
  }
  return agents;
}

export function useOpsFloorAgents(): { agents: AgentVisual[]; connected: boolean } {
  const [agentsBySlug, setAgentsBySlug] = useState<Record<string, AgentVisual>>(initialAgents);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const source = new EventSource(`/api/ai/agents/stream?token=${encodeURIComponent(token)}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.onmessage = (ev) => {
      let data: AgentEventPayload;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return; // keepalive comment lines etc.
      }
      if (!data.agent || !REAL_AGENT_SLUGS.includes(data.agent)) return; // agent not built yet

      setAgentsBySlug((prev) => {
        const existing = prev[data.agent];
        if (!existing) return prev;
        const state = toVisualState(data.status);
        return {
          ...prev,
          [data.agent]: {
            ...existing,
            state,
            offline: data.status === "disabled",
            taskId: data.task_id,
            activity: data.activity ?? (state === "idle" ? "Idle" : existing.activity),
            target: data.target,
          },
        };
      });
    };

    return () => source.close();
  }, []);

  const agents = Object.values(agentsBySlug);
  const activeCount = agents.filter((a) => a.state !== "idle").length;
  const gathering = activeCount >= 2;

  return {
    connected,
    agents: agents.map((a) =>
      a.slug === "coordinator" || !GATHER_SLOTS[a.slug]
        ? a
        : { ...a, position: gathering && a.state !== "idle" ? GATHER_SLOTS[a.slug] : a.home },
    ),
  };
}

export { STATIONS };
