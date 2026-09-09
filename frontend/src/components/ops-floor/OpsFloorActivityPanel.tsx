import { useEffect, useMemo, useState } from "react";
import { Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { STATE_COLOR, STATIONS, type AgentVisualState } from "@/lib/opsFloorTypes";
import type { ActivityEntry } from "@/lib/useAgentActivityFeed";

function dotColor(status: ActivityEntry["status"]): string {
  return STATE_COLOR[(status === "disabled" ? "idle" : status) as AgentVisualState];
}

function stationLabel(slug: string): string {
  return STATIONS.find((s) => s.slug === slug)?.label ?? slug;
}

/**
 * "Recent Activity" for the full-page Ops Floor - the same
 * /api/ai/agents/stream feed the AI dashboard's Live Activity card uses
 * (useAgentActivityFeed), with the filter/pause controls the reference
 * design calls for (per-agent, errors-only, pause auto-scroll).
 */
export function OpsFloorActivityPanel({ entries }: { entries: ActivityEntry[] }) {
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<ActivityEntry[]>(entries);

  useEffect(() => {
    if (!paused) setFrozen(entries);
  }, [entries, paused]);

  const live = paused ? frozen : entries;

  const filtered = useMemo(
    () => live.filter((e) => (agentFilter === "all" || e.agent === agentFilter) && (!errorsOnly || e.status === "error")),
    [live, agentFilter, errorsOnly],
  );

  const agentSlugs = useMemo(() => Array.from(new Set(entries.map((e) => e.agent))), [entries]);

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "#0B121C", border: "1px solid #1C2D40", borderRadius: 8 }}>
      <div className="flex items-center justify-between gap-2 p-3.5" style={{ borderBottom: "1px solid #152536" }}>
        <p style={{ fontSize: 15, fontWeight: 650, color: "#F3F7FB" }}>Recent Activity</p>
        <Button size="icon" variant="ghost" title={paused ? "Resume auto-scroll" : "Pause auto-scroll"} onClick={() => setPaused((v) => !v)}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 p-2" style={{ borderBottom: "1px solid #152536" }}>
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md px-1.5 py-1"
          style={{ background: "#111B29", border: "1px solid #1C2D40", color: "#C4D0DD", fontSize: 11 }}
        >
          <option value="all">All agents</option>
          {agentSlugs.map((slug) => (
            <option key={slug} value={slug}>
              {stationLabel(slug)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setErrorsOnly((v) => !v)}
          className="rounded-md px-2 py-1 font-medium transition-colors"
          style={
            errorsOnly
              ? { background: "rgba(255,77,103,0.12)", border: "1px solid #B83249", color: "#FF4D67", fontSize: 11 }
              : { background: "transparent", border: "1px solid #1C2D40", color: "#8799AD", fontSize: 11 }
          }
        >
          Errors only
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1">
        {filtered.length === 0 && (
          <p className="p-3" style={{ fontSize: 13, color: "#8799AD" }}>
            Waiting for agent activity…
          </p>
        )}
        {filtered.map((entry) => (
          <div key={entry.id} className="flex items-start gap-2 px-2.5 py-1.5" style={{ borderBottom: "1px solid #172638", minHeight: 38 }}>
            <span style={{ fontSize: 11, color: "#687C90", width: 44, flexShrink: 0, paddingTop: 1 }}>
              {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </span>
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor(entry.status) }} />
            <div className="min-w-0">
              <span style={{ fontSize: 13, fontWeight: 600, color: "#D8E4EF" }}>{stationLabel(entry.agent)}</span>
              <p className="truncate" style={{ fontSize: 12, color: "#9BAFC1" }}>
                {entry.activity ?? entry.status}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
