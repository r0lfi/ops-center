import { Link, useSearchParams } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentActivityFeed } from "@/lib/useAgentActivityFeed";

export default function AIAgentLogs() {
  const activity = useAgentActivityFeed();
  const [searchParams] = useSearchParams();
  // ?agent=<slug> - set when a workstation screen is clicked on the Ops Floor
  const agentFilter = searchParams.get("agent");
  const shown = agentFilter ? activity.filter((e) => e.agent === agentFilter) : activity;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Agent Logs</h1>
        {agentFilter && (
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded-md bg-accent px-2 py-1">
              Agent: <span className="font-medium">{agentFilter}</span>
            </span>
            <Link to="/ai-agents/agent-logs" className="text-xs text-primary hover:underline">
              Show all
            </Link>
          </div>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live activity</CardTitle>
          <p className="text-xs text-muted-foreground">Every agent state change, streamed live from the backend.</p>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {shown.length === 0 && (
            <p className="text-muted-foreground">{agentFilter ? `No activity from ${agentFilter} yet.` : "No agent activity yet."}</p>
          )}
          {shown.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-2 border-b border-border pb-2 last:border-0">
              <div>
                <span className="font-medium">{entry.agent}</span>
                <span className="text-muted-foreground"> {entry.activity || entry.status}</span>
                {entry.target && <span className="text-muted-foreground"> ({entry.target})</span>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
