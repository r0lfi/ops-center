import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AIAgent, type AITask } from "@/lib/api";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function AITasks() {
  const [tasks, setTasks] = useState<AITask[]>([]);
  const [agents, setAgents] = useState<AIAgent[]>([]);

  useEffect(() => {
    function refresh() {
      api.ai.tasks.list(100).then(setTasks).catch(() => {});
      api.ai.agents.list().then(setAgents).catch(() => {});
    }
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  const agentById = Object.fromEntries(agents.map((a) => [a.id, a]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All agent tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Task</th>
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Requested by</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                  <th className="px-4 py-3 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No tasks yet.
                    </td>
                  </tr>
                )}
                {tasks.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td className="max-w-xs truncate px-4 py-3">{t.input_message}</td>
                    <td className="px-4 py-3 text-muted-foreground">{agentById[t.agent_id]?.name ?? "-"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{t.source}</td>
                    <td className="px-4 py-3 text-muted-foreground">{t.requested_by || "-"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={t.status === "failed" ? "critical" : t.status === "completed" ? "ok" : "unknown"}>
                        {t.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}s` : "-"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{timeAgo(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
