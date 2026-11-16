import { Link } from "react-router-dom";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AITask } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const STATUS_WORD: Record<AITask["status"], string> = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };

function seconds(ms: number | null) {
  if (ms === null) return null;
  return ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}

/**
 * One task, start to finish: who asked, who worked on it, which steps ran
 * and what came out. Steps are the tools the task recorded; what remains is
 * unknown until the agent finishes, and says so.
 */
export function TaskDialog({ task, name, onClose }: { task: AITask | null; name: (idOrSlug: string) => string; onClose: () => void }) {
  const open = !!task;
  const target = (args: Record<string, unknown>) => ["hostname", "host", "target", "container"].map((key) => args[key]).find((value) => typeof value === "string") as string | undefined;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Task</DialogTitle></DialogHeader>
        {task && (
          <div className="of-task">
            <dl className="of-facts">
              <dt>Status</dt><dd className={`of-tx-${task.status === "failed" ? "error" : task.status === "running" || task.status === "queued" ? "working" : task.status === "completed" ? "completed" : "idle"}`}>{STATUS_WORD[task.status]}</dd>
              <dt>Agent</dt><dd>{name(task.agent_id)}</dd>
              <dt>Started by</dt><dd>{task.requested_by ?? `${task.source} (no user recorded)`}</dd>
              {task.started_at && <><dt>Started</dt><dd>{formatDateTime(task.started_at)}</dd></>}
              {task.completed_at && <><dt>Finished</dt><dd>{formatDateTime(task.completed_at)}{seconds(task.duration_ms) ? ` (${seconds(task.duration_ms)})` : ""}</dd></>}
              <dt>Agents</dt><dd>{task.agents_used.length ? task.agents_used.map(name).join(" → ") : "Only this agent so far"}</dd>
            </dl>

            <h3>What was asked</h3>
            <p className="of-task-text">{task.input_message}</p>

            <h3>Steps done</h3>
            {task.tools_used.length === 0
              ? <p className="of-muted">No tool steps recorded{task.status === "running" ? " yet" : ""}.</p>
              : <ol className="of-steps">{task.tools_used.map((step, index) => <li key={index}><span className="of-mono">{step.tool}</span>{target(step.arguments) ? <span className="of-muted"> on {target(step.arguments)}</span> : null}</li>)}</ol>}
            {(task.status === "running" || task.status === "queued") && <p className="of-muted">What remains is unknown until the agent reports back.</p>}
            {task.data_sources.length > 0 && <p className="of-muted">Data sources: {task.data_sources.join(", ")}</p>}

            {task.error_message && <><h3>Error</h3><p className="of-error">{task.error_message}</p></>}
            {task.response_message && <><h3>Result</h3><p className="of-task-text of-task-result">{task.response_message}</p></>}
            <p><Link className="of-link-btn" to="/ai-agents/tasks">All tasks</Link></p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
