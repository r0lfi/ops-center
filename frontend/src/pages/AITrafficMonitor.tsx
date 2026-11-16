import { lazy, Suspense } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";

import { BlockedView } from "@/components/ai-traffic/BlockedView";
import { FlowView } from "@/components/ai-traffic/FlowView";
import { LiveView } from "@/components/ai-traffic/LiveView";
import { OverviewView } from "@/components/ai-traffic/OverviewView";
import { SourcesView } from "@/components/ai-traffic/SourcesView";
import { TraceView } from "@/components/ai-traffic/TraceView";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAskOpsPageContext } from "@/lib/askOps";
import { cn } from "@/lib/utils";

// The map carries the world outline; load it only when the tab opens.
const MapView = lazy(() => import("@/components/ai-traffic/MapView").then(m => ({ default: m.MapView })));

export const AI_TRAFFIC_VIEWS = [
  { path: "", label: "Overview", view: OverviewView },
  { path: "live", label: "Live Traffic", view: LiveView },
  { path: "map", label: "Live Map", view: MapView },
  { path: "blocked", label: "Blocked & Failed", view: BlockedView },
  { path: "trace", label: "Agent Trace", view: TraceView },
  { path: "flow", label: "Network Flow", view: FlowView },
  { path: "sources", label: "Capture & Sources", view: SourcesView },
] as const;

/** AI Traffic Monitor: passive, read-only view of everything the AI layer does on the network. */
export default function AITrafficMonitor() {
  const { view = "" } = useParams();
  const current = AI_TRAFFIC_VIEWS.find(v => v.path === view);
  useAskOpsPageContext([current && { label: "View", value: current.label }]);
  if (!current) return <Navigate to="/ai-traffic" replace />;
  const View = current.view;
  return (
    <div className="space-y-4">
      <PageHeader
        title="AI Traffic Monitor"
        description="Who communicated, where, what they tried, what happened and which agent was behind it. Passive and read-only: nothing here blocks, redirects or changes traffic or firewall rules."
      />
      <nav aria-label="AI Traffic Monitor views" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
        {AI_TRAFFIC_VIEWS.map(v => (
          <NavLink key={v.path} to={v.path ? `/ai-traffic/${v.path}` : "/ai-traffic"} end
            className={({ isActive }) => cn("shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {v.label}
          </NavLink>
        ))}
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}><View /></Suspense>
    </div>
  );
}
