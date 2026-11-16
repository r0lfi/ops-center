import type { CollaborationDetail, CollaborationSummary } from "@/lib/api";

export const isActive = (row: CollaborationSummary) => ["queued", "running"].includes(row.board.status) && ["queued", "running"].includes(row.task_status);
export function titleOf(question: string): string {
  const first = question.trim().split(/\n/).find(line => line.trim()) || "Untitled investigation";
  const clean = first.replace(/^Problem:\s*/i, "").replace(/^[#*>\s]+/, "").replace(/\*\*/g, "").trim();
  return clean.length > 78 ? clean.slice(0, 75).trimEnd() + "…" : clean;
}
export function statusOf(row: CollaborationSummary): string {
  if (row.board.status === "failed" || row.task_status === "failed") return "Failed";
  if (row.board.status === "stopped" || row.task_status === "cancelled") return "Stopped";
  if (row.task_status === "completed") return "Completed";
  if (row.board.status === "queued") return "Waiting";
  if (row.board.status === "running") return "Investigating";
  return row.board.status;
}
export function resourcesOf(question: string): string | null {
  return question.match(/^Affected resources: (.+)$/m)?.[1] || null;
}
export function severityOf(question: string): string | null {
  return question.match(/^Severity \(operator supplied\): (Low|Medium|High|Critical)$/m)?.[1] || null;
}
export function durationOf(detail: CollaborationDetail, now: number): string {
  const start = Date.parse(detail.task_started_at || detail.board.created_at);
  const end = detail.task_completed_at ? Date.parse(detail.task_completed_at) : isActive(detail) ? now : Date.parse(detail.posts.at(-1)?.created_at || detail.board.created_at);
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  const hours = Math.floor(seconds / 3600);
  return (hours ? hours + ":" : "") + String(Math.floor(seconds / 60) % 60).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
