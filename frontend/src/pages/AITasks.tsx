import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { InvestigationBoard, StatusBadge } from "@/components/ai/InvestigationBoard";
import { PageHeader } from "@/components/layout/PageHeader";
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
  const [params] = useSearchParams();
  const selectedId = params.get("task");
  const [selected, setSelected] = useState<AITask | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    setSelected(null); setDetailError("");
    if (!selectedId) return;
    let live = true;
    async function refresh() {
      try { const task = await api.ai.tasks.get(selectedId!); if (live) { setSelected(task); setDetailError(""); } }
      catch (error) { if (live) { setSelected(null); setDetailError(error instanceof Error ? error.message : "Investigation unavailable"); } }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => { live = false; clearInterval(timer); };
  }, [selectedId]);
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
      <PageHeader title="Tasks" description="Everything agents have been asked to do, from chat, Talk and incidents." />
      {selectedId && <Card><CardHeader><CardTitle className="text-base">Investigation and findings</CardTitle></CardHeader><CardContent className="space-y-3">
        {detailError ? <p role="alert" className="text-sm text-destructive">{detailError}</p> : !selected ? <p role="status" className="text-sm text-muted-foreground">Loading investigation…</p> : <>
          <p className="text-xs text-muted-foreground">{selected.status} · {agentById[selected.agent_id]?.name || "Agent"} · {selected.source}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{selected.input_message}</p>
          <InvestigationBoard task={selected} />
          <h3 className="text-sm font-medium">Answer</h3>
          <p className="whitespace-pre-wrap break-words rounded-md bg-secondary p-3 text-sm">{selected.response_message || selected.error_message || "Waiting for the agent's findings."}</p>
          <p className="text-xs text-muted-foreground">A completed investigation is a report. "The service answers", "the service is healthy" and "the problem is fixed" are different claims: check the evidence above before acting on it.</p>
        </>}
      </CardContent></Card>}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All agent tasks</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="ops-card-table w-full text-sm">
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
                    <td data-label="Task" className="max-w-xs truncate px-4 py-3"><Link className="text-primary hover:underline" to={`/ai-agents/tasks?task=${encodeURIComponent(t.id)}`}>{t.input_message}</Link></td>
                    <td data-label="Agent" className="px-4 py-3 text-muted-foreground">{agentById[t.agent_id]?.name ?? "-"}</td>
                    <td data-label="Source" className="px-4 py-3 text-muted-foreground">{t.source}</td>
                    <td data-label="Requested by" className="px-4 py-3 text-muted-foreground">{t.requested_by || "-"}</td>
                    <td data-label="Status" className="px-4 py-3">
                      <StatusBadge status={t.status === "completed" && t.outcome ? t.outcome : t.status} />
                    </td>
                    <td data-label="Duration" className="px-4 py-3 text-muted-foreground">{t.duration_ms ? `${(t.duration_ms / 1000).toFixed(1)}s` : "-"}</td>
                    <td data-label="When" className="px-4 py-3 text-muted-foreground">{timeAgo(t.created_at)}</td>
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
