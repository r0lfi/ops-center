import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type AITask, type AITaskBoard, type AIWorkItemStatus } from "@/lib/api";

type Variant = "ok" | "warning" | "critical" | "unknown" | "secondary";

export const STATUS_VARIANT: Record<string, Variant> = {
  queued: "unknown",
  running: "warning",
  waiting_for_agent: "warning",
  waiting_for_approval: "warning",
  blocked: "critical",
  completed: "ok",
  failed: "critical",
  inconclusive: "warning",
  cancelled: "unknown",
  proposed: "unknown",
  in_development: "warning",
  ready_for_review: "warning",
  changes_requested: "warning",
  approved: "ok",
  deployed: "ok",
  rejected: "unknown",
  release_failed: "critical",
  rolled_back: "critical",
};

const STATUS_LABEL: Record<string, string> = {
  waiting_for_agent: "waiting for agent",
  waiting_for_approval: "waiting for approval",
  in_development: "in development",
  ready_for_review: "ready for review",
  changes_requested: "changes requested",
  deployed: "in production",
  release_failed: "release failed",
  rolled_back: "rolled back",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "unknown"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

const KIND_LABEL = { fact: "Fact", hypothesis: "Hypothesis", ruled_out: "Ruled out", resolution: "Resolution" } as const;

function itemStatus(status: AIWorkItemStatus, dependsOpen: boolean): string {
  return status === "queued" && dependsOpen ? "waiting_for_agent" : status;
}

function shortTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

/** Live view of one investigation, built only from backend state (board, findings, approvals). */
export function InvestigationBoard({ task }: { task: AITask }) {
  const [board, setBoard] = useState<AITaskBoard | null>(null);
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState(false);
  const navigate = useNavigate();
  const live = task.status === "queued" || task.status === "running";

  useEffect(() => {
    let active = true;
    const load = () =>
      api.ai.tasks.board(task.id)
        .then((data) => { if (active) { setBoard(data); setError(""); } })
        .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Board unavailable"); });
    void load();
    const timer = setInterval(load, live ? 3000 : 15000);
    return () => { active = false; clearInterval(timer); };
  }, [task.id, live]);

  async function resume() {
    setResuming(true);
    try {
      const { task_id } = await api.ai.tasks.resume(task.id);
      navigate(`/ai-agents/tasks?task=${encodeURIComponent(task_id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resume");
    } finally {
      setResuming(false);
    }
  }

  if (error && !board) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!board) return <p role="status" className="text-sm text-muted-foreground">Loading investigation board…</p>;

  const done = new Set(board.items.filter((i) => !["queued", "running"].includes(i.status)).map((i) => i.id));
  const pendingActions = board.actions.filter((a) => a.status === "pending");
  const open = board.items.filter((i) => !["completed"].includes(i.status));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Status</span>
        <StatusBadge status={live ? task.status : board.outcome ?? task.status} />
        {board.resumed_by && (
          <Link className="text-primary hover:underline" to={`/ai-agents/tasks?task=${encodeURIComponent(board.resumed_by)}`}>
            Continued in a new run
          </Link>
        )}
        {board.resumable && (
          <Button size="sm" variant="outline" disabled={resuming} onClick={resume}>
            {resuming ? "Resuming…" : "Resume from saved state"}
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <section aria-label="Work items">
        <h3 className="mb-2 text-sm font-medium">Work items</h3>
        {board.items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{live ? "The coordinator has not delegated anything yet." : "No delegated work for this task."}</p>
        ) : (
          <ol className="space-y-2">
            {board.items.map((item) => {
              const waits = item.depends_on.some((d) => !done.has(d));
              return (
                <li key={item.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={itemStatus(item.status, waits)} />
                    <span className="text-sm font-medium capitalize">{item.agent}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.finished_at ? `finished ${shortTime(item.finished_at)}` : item.started_at ? `started ${shortTime(item.started_at)}` : "queued"}
                      {item.attempts > 1 ? ` · attempt ${item.attempts}` : ""}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-sm">{item.title}</p>
                  {item.tools.length > 0 && (
                    <p className="mt-1 break-words text-xs text-muted-foreground">Tools: {Array.from(new Set(item.tools)).join(", ")}</p>
                  )}
                  {item.result && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-primary">Result</summary>
                      <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-secondary p-2 text-xs">{item.result}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {pendingActions.length > 0 && (
        <section aria-label="Waiting for approval" className="rounded-md border border-status-warning/40 p-3">
          <h3 className="text-sm font-medium">Waiting for your approval</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {pendingActions.map((a) => <li key={a.id}><code>{a.code}</code> · {a.tool} · level {a.level}</li>)}
          </ul>
          <Link className="mt-2 inline-block text-xs text-primary hover:underline" to="/ai-agents/approvals">Open approvals</Link>
        </section>
      )}

      {board.findings.length > 0 && (
        <section aria-label="Findings">
          <h3 className="mb-2 text-sm font-medium">Findings</h3>
          <ul className="space-y-1 text-sm">
            {board.findings.map((f) => (
              <li key={f.id} className="break-words">
                <Badge variant={f.kind === "ruled_out" ? "unknown" : f.kind === "hypothesis" ? "warning" : "ok"}>{KIND_LABEL[f.kind]}</Badge>{" "}
                <span className="text-muted-foreground">{f.system}:</span> {f.statement}
                {f.source && <span className="text-xs text-muted-foreground"> ({f.source})</span>}
                {f.stale && <span className="text-xs text-status-warning"> · stale</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {board.proposals.length > 0 && (
        <section aria-label="Tool proposals">
          <h3 className="mb-2 text-sm font-medium">Proposed new tools</h3>
          <ul className="space-y-1 text-sm">
            {board.proposals.map((p) => (
              <li key={p.id}>
                <StatusBadge status={p.status === "proposed" ? "waiting_for_approval" : p.status} /> {p.title}{" "}
                <Link className="text-xs text-primary hover:underline" to="/ai-agents/approvals#proposals">Review</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!live && open.length > 0 && board.outcome !== "completed" && (
        <p className="text-xs text-muted-foreground">
          Still open: {open.map((i) => `${i.agent} (${STATUS_LABEL[i.status] ?? i.status})`).join(", ")}.
        </p>
      )}
    </div>
  );
}
