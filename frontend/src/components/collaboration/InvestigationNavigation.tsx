import { useEffect, useState } from "react";
import { Clock3, Plus, ArrowLeft, ArrowRight, Radio, ListFilter } from "lucide-react";
import type { AIAgent, CollaborationDetail, CollaborationSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AgentBadge, agentLabel } from "./identity";
import { durationOf, isActive, resourcesOf, severityOf, statusOf, titleOf } from "./workspace";

export function StatusBadge({ status }: { status: string }) {
  const color = status === "Completed" ? "text-emerald-400 bg-emerald-400/10" : status === "Failed" ? "text-red-400 bg-red-400/10" : status === "Investigating" ? "text-cyan-300 bg-cyan-400/10" : "text-amber-300 bg-amber-400/10";
  return <span className={"inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider " + color}><span className="h-1.5 w-1.5 rounded-full bg-current" />{status}</span>;
}
export function InvestigationHeader({ detail, agents, updatedAt }: { detail: CollaborationDetail; agents: AIAgent[]; updatedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!isActive(detail)) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [detail.board.status, detail.task_status]);
  const resources = resourcesOf(detail.question), severity = severityOf(detail.question);
  return <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground"><span className="font-mono">INV · {detail.board.task_id.slice(0, 8)}</span><span> / </span><span>Collaboration workspace</span></div>
      <h1 className="break-words text-lg font-semibold leading-snug sm:text-xl" title={titleOf(detail.question)}>{titleOf(detail.question)}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentBadge slug={detail.lead_agent || detail.board.participants[0] || "coordinator"} size={20} />
        <span>{agentLabel(detail.lead_agent || detail.board.participants[0] || "coordinator", agents)} · Lead</span>
        {resources && <span className="max-w-[20rem] truncate" title={resources}>· {resources}</span>}
        {severity && <span className="text-amber-300">· {severity} priority</span>}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge status={statusOf(detail)} />
      <span className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground" title={detail.task_completed_at || isActive(detail) ? "Investigation duration" : "Span of recorded activity"}><Clock3 className="h-3.5 w-3.5" />{durationOf(detail, now)}</span>
      {updatedAt && isActive(detail) && <span className="flex items-center gap-1 text-[10px] text-cyan-400"><Radio className="h-3 w-3" />Live updates</span>}
    </div>
  </div>;
}
export function InvestigationSidebar({ boards, agents, selected, onSelect, onNew, offset, onOffset, error, canStart }: {
  boards: CollaborationSummary[]; agents: AIAgent[]; selected: string; onSelect: (id: string) => void; onNew: () => void; offset: number; onOffset: (offset: number) => void; error: string; canStart: boolean;
}) {
  const [filter, setFilter] = useState("All");
  const visible = boards.filter(row => filter === "All" || (filter === "Active" ? isActive(row) : statusOf(row) === "Completed"));
  return <nav aria-label="Investigations" className="flex h-full min-w-0 flex-col gap-4 p-4">
    <div className="flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-300">Investigations</h2><span className="text-[10px] text-muted-foreground">{boards.length}</span></div>
    <Button className="w-full gap-2" onClick={onNew} disabled={!canStart}><Plus className="h-4 w-4" />New investigation</Button>
    <div aria-label="Investigation filters" className="flex rounded-md bg-black/20 p-1">{["Active", "Completed", "All"].map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={"flex-1 rounded px-2 py-1.5 text-[11px] " + (filter === value ? "bg-slate-700/60 text-slate-100" : "text-muted-foreground hover:text-white")}>{value}</button>)}</div>
    {error && <p role="alert" className="text-xs text-red-400">Could not load investigations: {error}</p>}
    <div className="min-h-0 flex-1 space-y-2">{visible.map(row => <button type="button" key={row.board.task_id} aria-pressed={selected === row.board.task_id} aria-label={titleOf(row.question)} onClick={() => onSelect(row.board.task_id)} className={"w-full min-w-0 rounded-lg border p-3 text-left transition-colors " + (selected === row.board.task_id ? "border-cyan-400/30 bg-cyan-400/[0.06]" : "border-transparent bg-white/[0.02] hover:bg-white/[0.04]")}>
      <div className="mb-2 flex items-center justify-between gap-1"><span className="font-mono text-[9px] uppercase text-muted-foreground">{row.board.task_id.slice(0, 8)}</span><StatusBadge status={statusOf(row)} /></div>
      <h3 className="line-clamp-2 break-words text-sm font-medium leading-snug">{titleOf(row.question)}</h3>
      <p className="mt-2 truncate text-[11px] text-muted-foreground">{agentLabel(row.lead_agent || row.board.participants[0] || "coordinator", agents)}</p>
      <div className="mt-3 flex items-center justify-between"><div className="flex -space-x-1">{row.board.participants.slice(0, 5).map(slug => <AgentBadge key={slug} slug={slug} size={23} />)}</div><time className="text-[10px] text-muted-foreground" dateTime={row.board.created_at}>{new Date(row.board.created_at).toLocaleDateString("en-GB", { month: "short", day: "numeric" })}</time></div>
    </button>)}
      {!visible.length && !error && <div className="py-8 text-center text-xs text-muted-foreground"><ListFilter className="mx-auto mb-2 h-5 w-5" />No {filter === "All" ? "" : filter.toLowerCase() + " "}investigations on this page.</div>}
    </div>
    <div className="flex items-center justify-between border-t border-white/5 pt-3"><Button aria-label="Previous investigations" size="sm" variant="ghost" disabled={!offset} onClick={() => onOffset(Math.max(0, offset - 30))}><ArrowLeft className="h-3 w-3" /></Button><span className="text-[10px] text-muted-foreground">Page {Math.floor(offset / 30) + 1}</span><Button aria-label="Next investigations" size="sm" variant="ghost" disabled={boards.length < 30} onClick={() => onOffset(offset + 30)}><ArrowRight className="h-3 w-3" /></Button></div>
  </nav>;
}
export function InvestigationProgress({ detail }: { detail: CollaborationDetail }) {
  const steps = ["Problem", "Collaboration", "Evidence", "Conclusion"];
  const concluded = detail.posts.some(post => post.kind === "summary") || !!detail.response_message;
  const evidence = detail.posts.some(post => post.kind === "evidence");
  const current = concluded ? 3 : evidence ? 2 : detail.posts.length ? 1 : 0;
  return <ol aria-label="Investigation progress" className="flex flex-wrap gap-x-3 gap-y-2 rounded-lg border border-white/5 bg-black/10 px-4 py-3">{steps.map((step, index) => <li key={step} aria-current={index === current ? "step" : undefined} className={"flex items-center gap-2 text-[10px] uppercase tracking-wider " + (index === current ? "text-cyan-300" : "text-slate-500")}><span className={"flex h-4 w-4 items-center justify-center rounded-full border text-[9px] " + (index === current ? "border-cyan-400 bg-cyan-400/10" : "border-slate-700")}>{index + 1}</span>{step}{index < steps.length - 1 && <span className="ml-1 text-slate-700">—</span>}</li>)}</ol>;
}
