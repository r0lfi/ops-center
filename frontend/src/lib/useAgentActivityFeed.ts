import { useSessionToken } from "@/lib/auth";
import { useEffect, useState } from "react";

import { type AgentStatus } from "@/lib/api";

export interface ActivityEntry {
  id: string;
  agent: string;
  status: AgentStatus;
  activity: string | null;
  target: string | null;
  ts: number;
}

const MAX_ENTRIES = 30;

/**
 * Same /api/ai/agents/stream SSE the Ops Floor uses (see opsFloorEvents.ts),
 * consumed here as a plain chronological log instead of driving 3D
 * position/state - powers the AI Agents page's Live Activity feed.
 */
export function useAgentActivityFeed(): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  const token = useSessionToken();
  useEffect(() => {
    if (!token) return;

    const source = new EventSource(`/api/ai/agents/stream?token=${encodeURIComponent(token)}`);
    source.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (!data.agent) return;
        const entry: ActivityEntry = {
          id: `${data.agent}-${data.ts ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          agent: data.agent,
          status: data.status,
          activity: data.activity,
          target: data.target,
          ts: typeof data.ts === "number" ? data.ts * 1000 : Date.now(),
        };
        setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
      } catch {
        // keepalive comment lines etc.
      }
    };

    return () => source.close();
  }, [token]);

  return entries;
}
