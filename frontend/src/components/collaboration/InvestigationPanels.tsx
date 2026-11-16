import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { agentLabel } from "@/components/ai/AgentIdentity";
import { Activity, ArrowUpRight, BookOpen, CheckCheck, ChevronDown, Clock3, FileSearch, GitBranch, Lightbulb, Search, Terminal, Wallet, type LucideIcon } from "lucide-react";
import { api, type AIAgent, type AIWeeklyBudget, type CollaborationDetail, type CollaborationExperiences, type CollaborationPost } from "@/lib/api";
import { formatClock, formatDate, formatDateTime } from "@/lib/format";

type PanelProps = { detail: CollaborationDetail; agents: AIAgent[] };
type DetailMetadata = {
  lead_agent?: string | null;
  task_started_at?: string | null; task_completed_at?: string | null;
  tool_executions?: { tool: string; arguments: Record<string, unknown> }[];
  data_sources?: string[]; confidence?: number | null; response_message?: string | null;
};
const meta = (detail: CollaborationDetail) => detail as CollaborationDetail & DetailMetadata;
const nameOf = (slug: string, agents: AIAgent[]) => agentLabel(agents.find(agent => agent.slug === slug || agent.id === slug)?.slug || slug, agents);
const excerpt = (value: string, length = 150) => { const text = value.replace(/\s+/g, " ").trim(); return text.length > length ? text.slice(0, length).trimEnd() + "…" : text; };
const dateValue = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const timeLabel = (value: string | null | undefined) => (dateValue(value) ? formatClock(value) : "") || "Time not recorded";
const fullDate = (value: string | null | undefined) => (dateValue(value) ? formatDateTime(value) : "") || "Not recorded";
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value);
const kinds: Record<string, string> = { question: "Question", answer: "Answer", evidence: "Evidence", hypothesis: "Hypothesis", experience: "Experience", summary: "Final summary", system: "Status update" };

function Panel({ title, icon: Icon, children, count, className = "" }: { title: string; icon: LucideIcon; children: ReactNode; count?: number; className?: string }) {
  return <section aria-label={title} className={`min-w-0 rounded-xl border border-slate-700/50 bg-[#111b27] ${className}`}>
    <header className="flex items-center gap-2 px-4 pb-3 pt-4"><Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" /><h2 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-slate-300">{title}</h2>{count !== undefined && <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400">{count}</span>}</header>
    <div className="px-4 pb-4">{children}</div>
  </section>;
}

function TextDisclosure({ content, label = "Full text", length = 150 }: { content: string; label?: string; length?: number }) {
  return <details className="group min-w-0 text-xs">
    <summary className="cursor-pointer list-none rounded-sm text-slate-300 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
      <span className="block break-words leading-relaxed group-open:hidden">{excerpt(content, length)}</span>
      <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-cyan-300/90"><ChevronDown aria-hidden="true" className="h-3 w-3 transition-transform group-open:rotate-180" />{label}</span>
    </summary>
    <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950/40 p-3 text-xs leading-relaxed text-slate-300">{content}</div>
  </details>;
}

function PostNote({ post, agents }: { post: CollaborationPost; agents: AIAgent[] }) {
  return <div className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-950/20 p-3">
    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]"><span className="font-medium text-slate-400">{nameOf(post.agent, agents)}</span><time dateTime={post.created_at} title={fullDate(post.created_at)} className="ml-auto text-slate-500">{timeLabel(post.created_at)}</time></div>
    <TextDisclosure content={post.content} />
  </div>;
}

export function InvestigationState({ detail, agents }: PanelProps) {
  const data = meta(detail);
  const status = ["failed", "cancelled"].includes(detail.task_status) ? detail.task_status : detail.board.status;
  const labels: Record<string, string> = { queued: "Queued", running: "Investigating", completed: "Completed", stopped: "Stopped", failed: "Failed", cancelled: "Cancelled" };
  const busy = status === "running" || status === "queued";
  const stopped = ["failed", "stopped", "cancelled"].includes(status);
  const start = dateValue(data.task_started_at);
  const end = dateValue(data.task_completed_at);
  const seconds = start && (end || busy) ? Math.max(0, Math.floor(((end?.getTime() ?? Date.now()) - start.getTime()) / 1000)) : null;
  const duration = seconds === null ? "Not recorded" : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  const lead = data.lead_agent ? nameOf(data.lead_agent, agents) : null;
  const confidence = typeof data.confidence === "number" && data.confidence >= 0 && data.confidence <= 100 ? data.confidence : null;
  const orderedPosts = [...detail.posts].sort((a, b) => a.sequence - b.sequence);
  const participantSlugs = [...new Set([...detail.board.participants, ...orderedPosts.filter(post => post.kind !== "system").map(post => post.agent)])];
  const answeredQuestions = new Set(orderedPosts.filter(post => post.kind === "answer" && post.reply_to_id).map(post => post.reply_to_id));
  const stateFor = (slug: string) => {
    const pendingQuestion = orderedPosts.some(post => post.kind === "question" && post.recipient === slug && !answeredQuestions.has(post.id));
    if (pendingQuestion) return busy ? "Reply pending" : "Unanswered question";
    const latest = [...orderedPosts].reverse().find(post => post.agent === slug && post.kind !== "system");
    const states: Record<string, string> = { question: "Asked a question", answer: "Answered", evidence: "Shared evidence", hypothesis: "Shared hypothesis", experience: "Shared experience", summary: "Summary posted" };
    return latest ? states[latest.kind] || "Posted an update" : "No posts yet";
  };
  const findings = orderedPosts.filter(post => post.kind === "evidence").slice(-3).reverse();
  const hypotheses = orderedPosts.filter(post => post.kind === "hypothesis").slice(-2).reverse();
  const toolCounts = new Map<string, number>();
  for (const entry of data.tool_executions || []) if (entry.tool) toolCounts.set(entry.tool, (toolCounts.get(entry.tool) || 0) + 1);
  return <Panel title="Investigation state" icon={Activity}>
    <div className="mb-4 flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${busy ? "bg-cyan-400" : stopped ? "bg-amber-400" : "bg-emerald-400"}`} /><span className={`text-sm font-medium ${stopped ? "text-amber-300" : "text-slate-100"}`}>{labels[status] || status}</span>{busy && <span className="ml-auto text-[10px] text-slate-500">Live</span>}</div>
    <dl className="space-y-2.5 text-xs">
      {[["Lead agent", lead || "Not recorded"], ["Participants", String(detail.board.participants.length)], ["Model calls", String(detail.board.model_calls)], [end ? "Duration" : "Elapsed", duration], ["Opened", fullDate(detail.board.created_at)]].map(([label, value]) => <div key={label} className="flex items-start justify-between gap-3"><dt className="shrink-0 text-slate-500">{label}</dt><dd className="min-w-0 break-words text-right text-slate-300">{value}</dd></div>)}
      {confidence !== null && <div className="flex justify-between gap-3"><dt className="text-slate-500">Reported confidence</dt><dd className="text-slate-300">{confidence}%</dd></div>}
    </dl>
    {detail.board.stop_reason && <p className="mt-3 border-t border-slate-700/50 pt-3 text-xs leading-relaxed text-amber-300/90">{detail.board.stop_reason}</p>}
    <div className="mt-4 border-t border-slate-700/50 pt-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agents</h3>
      <ul className="space-y-2">{participantSlugs.map(slug => <li key={slug} className="flex min-w-0 items-start justify-between gap-2 text-[10px]"><span className="min-w-0 break-words font-medium text-slate-300">{nameOf(slug, agents)}</span><span className="shrink-0 text-right text-slate-500">{stateFor(slug)}</span></li>)}</ul>
      {!participantSlugs.length && <p className="text-[10px] text-slate-500">No participants recorded.</p>}
    </div>
    {[{ title: "Findings", posts: findings, color: "text-cyan-300/80", empty: "No evidence posted yet." }, { title: "Hypotheses", posts: hypotheses, color: "text-amber-300/80", empty: "No hypotheses posted yet." }].map(group => <div key={group.title} className="mt-3 border-t border-slate-700/50 pt-3">
      <h3 className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${group.color}`}>{group.title}<span className="ml-2 font-normal normal-case tracking-normal text-slate-600">latest</span></h3>
      <div className="space-y-2.5">{group.posts.map(post => <div key={post.id} className="min-w-0"><p className="mb-0.5 text-[10px] text-slate-500">{nameOf(post.agent, agents)}</p><TextDisclosure content={post.content} length={90} label="Read note" /></div>)}</div>
      {!group.posts.length && <p className="text-[10px] text-slate-500">{group.empty}</p>}
    </div>)}
    <div className="mt-3 border-t border-slate-700/50 pt-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Recorded tools</h3>
      {toolCounts.size > 0 ? <div className="space-y-1.5">{[...toolCounts].map(([tool, count]) => <div key={tool} className="flex min-w-0 items-start gap-2 text-[10px]"><span className="min-w-0 break-all font-mono text-slate-400">{tool}</span><span className="ml-auto shrink-0 font-mono text-cyan-300/80">×{count}</span></div>)}</div> : <p className="text-[10px] text-slate-500">No tool calls recorded.</p>}
    </div>
  </Panel>;
}

export function EvidencePanel({ detail, agents }: PanelProps) {
  const evidence = detail.posts.filter(post => post.kind === "evidence");
  const hypotheses = detail.posts.filter(post => post.kind === "hypothesis");
  const sources = meta(detail).data_sources || [];
  return <Panel title="Evidence & hypotheses" icon={FileSearch} count={evidence.length + hypotheses.length}>
    {sources.length > 0 && <div className="mb-4 flex flex-wrap gap-1.5" aria-label="Recorded data sources">{sources.map(source => <span key={source} className="rounded-md border border-cyan-400/15 bg-cyan-400/5 px-2 py-1 text-[10px] text-cyan-200/80">{source}</span>)}</div>}
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      {[{ name: "Evidence", posts: evidence, Icon: FileSearch, color: "text-cyan-300" }, { name: "Hypotheses", posts: hypotheses, Icon: Lightbulb, color: "text-amber-300" }].map(group => <div key={group.name} className="min-w-0">
        <h3 className={`mb-2.5 flex items-center gap-1.5 text-xs font-medium ${group.color}`}><group.Icon aria-hidden="true" className="h-3.5 w-3.5" />{group.name}<span className="ml-auto text-[10px] text-slate-500">{group.posts.length}</span></h3>
        <div className="space-y-2">{group.posts.map(post => <PostNote key={post.id} post={post} agents={agents} />)}{!group.posts.length && <p className="rounded-lg border border-dashed border-slate-700/60 p-3 text-xs text-slate-500">No {group.name.toLowerCase()} recorded yet.</p>}</div>
      </div>)}
    </div>
  </Panel>;
}

export function ResolutionPanel({ detail, agents }: PanelProps) {
  const summary = [...detail.posts].reverse().find(post => post.kind === "summary");
  const text = summary?.content || meta(detail).response_message;
  const complete = detail.board.status === "completed" && detail.task_status === "completed";
  const terminal = complete || ["stopped", "failed", "cancelled"].includes(detail.board.status) || ["failed", "cancelled"].includes(detail.task_status);
  if (!text && !terminal) return null;
  return <Panel title="Investigation outcome" icon={CheckCheck}>
    <div className="mb-2 flex flex-wrap items-center gap-2"><span className={`rounded-md px-2 py-1 text-[10px] font-medium ${complete ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>{complete ? "Investigation completed" : terminal ? "Partial investigation" : "Summary pending"}</span>{summary && <span className="text-[10px] text-slate-500">{nameOf(summary.agent, agents)} · {timeLabel(summary.created_at)}</span>}</div>
    {text ? <TextDisclosure content={text} length={220} label="Read investigation summary" /> : <p className="text-xs leading-relaxed text-slate-500">{terminal ? "No final summary was recorded. Review the timeline for collected evidence." : "The final summary will appear here when the investigation finishes."}</p>}
    {text && <p className="mt-3 text-[10px] leading-relaxed text-slate-500">A completed investigation does not establish that the underlying issue is resolved.</p>}
  </Panel>;
}

export function InvestigationTimeline({ detail, agents, compact = false }: PanelProps & { compact?: boolean }) {
  const ordered = [...detail.posts].sort((a, b) => a.sequence - b.sequence);
  const visible = compact ? ordered.slice(-5) : ordered;
  const visibleIds = new Set(visible.map(post => post.id));
  const postAnchor = (id: string) => `timeline-${compact ? "compact-" : ""}post-${id}`;
  const tools = meta(detail).tool_executions || [];
  return <Panel title="Investigation timeline" icon={Clock3} count={ordered.length}>
    {compact && ordered.length > visible.length && <p className="mb-3 text-[10px] text-slate-500">Latest {visible.length} of {ordered.length} recorded posts</p>}
    <ol className="space-y-3">
      {visible.map(post => {
        const question = post.reply_to_id ? ordered.find(item => item.id === post.reply_to_id) : undefined;
        return <li key={post.id} id={postAnchor(post.id)} className="relative flex min-w-0 gap-3">
          <div className="relative flex w-3 shrink-0 justify-center"><span className={`relative z-10 mt-1 h-1.5 w-1.5 rounded-full ${post.kind === "hypothesis" ? "bg-amber-400" : post.kind === "summary" ? "bg-emerald-400" : "bg-cyan-400/80"}`} /><span className="absolute bottom-[-14px] top-3 w-px bg-slate-700/70" /></div>
          <div className="min-w-0 flex-1 pb-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]"><span className="font-medium text-slate-300">{nameOf(post.agent, agents)}</span><span className="text-slate-500">{kinds[post.kind] || post.kind}</span><time className="ml-auto text-slate-500" dateTime={post.created_at} title={fullDate(post.created_at)}>{timeLabel(post.created_at)}</time></div>
            {post.recipient && <p className="mb-1 text-[10px] text-cyan-300/80">To {nameOf(post.recipient, agents)}</p>}
            {question && <p className="mb-1.5 text-[10px] text-cyan-300/80">{visibleIds.has(question.id) ? <a className="underline decoration-cyan-300/30 underline-offset-2 hover:text-cyan-100" href={`#${postAnchor(question.id)}`}>Reply to question #{question.sequence}</a> : `Reply to question #${question.sequence}`}<span className="ml-1 text-slate-500">from {nameOf(question.agent, agents)}</span></p>}
            <TextDisclosure content={post.content} length={compact ? 135 : 210} label={compact ? "Details" : "Full post"} />
          </div>
        </li>;
      })}
    </ol>
    {!ordered.length && <p className="text-xs text-slate-500">No activity has been recorded yet.</p>}
    {!compact && <div className="mt-5 border-t border-slate-700/60 pt-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400"><Terminal aria-hidden="true" className="h-3 w-3" />Recorded tool calls<span className="ml-auto font-mono text-slate-500">{tools.length}</span></h3>
      {tools.length ? <><p className="mb-2 text-[10px] leading-relaxed text-slate-500">Shown in recorded order. Per-call timestamps, agent attribution and results are not available.</p><div className="space-y-1.5 rounded-lg border border-slate-800 bg-[#080f18] p-3">{tools.map((tool, index) => <details key={`${tool.tool}-${index}`} className="group min-w-0 font-mono text-[11px]"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><span className="text-slate-600">{String(index + 1).padStart(2, "0")}</span><span className="break-all text-cyan-200">{tool.tool}</span><ChevronDown aria-hidden="true" className="ml-auto h-3 w-3 shrink-0 text-slate-500 group-open:rotate-180" /></summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all border-l border-slate-700 pl-3 text-[10px] leading-relaxed text-slate-400">{JSON.stringify(tool.arguments, null, 2)}</pre></details>)}</div></> : <p className="text-xs text-slate-500">No tool calls recorded for this investigation.</p>}
    </div>}
  </Panel>;
}

export function SharedExperiencePanel({ experiences, query, onQueryChange, error, agents = [] }: { experiences: CollaborationExperiences | null; query: string; onQueryChange: (value: string) => void; error: string; agents?: AIAgent[] }) {
  return <Panel title="Shared experience" icon={BookOpen} count={experiences?.items.length}>
    <label className="mb-3 flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-950/30 px-3 py-2 focus-within:border-cyan-400/50"><Search aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-500" /><input aria-label="Search saved experiences" maxLength={200} value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search past investigations…" className="min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-500" /></label>
    <p className="mb-3 text-[10px] leading-relaxed text-slate-500">Notes from your earlier discussions. Recheck their relevance before reusing them.</p>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[10px]">
      <span className={experiences?.memory_enabled === false ? "text-amber-300" : "text-slate-400"}>{experiences ? experiences.memory_enabled ? "Experience recall enabled" : "Experience recall paused" : "Memory preference loading…"}</span>
      <Link to="/ai-agents/memory" className="text-cyan-300 hover:underline">Memory settings</Link>
    </div>
    {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : !experiences ? <p className="text-xs text-slate-500">Loading saved experiences…</p> : experiences.items.length === 0 ? <div className="rounded-lg border border-dashed border-slate-700/70 p-4 text-center"><GitBranch aria-hidden="true" className="mx-auto mb-2 h-5 w-5 text-slate-600" /><p className="text-xs text-slate-400">{query ? "No matching experience notes." : "No shared experiences yet."}</p><p className="mt-1 text-[10px] leading-relaxed text-slate-500">Experience posts from completed discussions will appear here.</p></div> : <div className="space-y-2.5">{experiences.items.map(item => <article key={item.id} className="min-w-0 rounded-lg border border-slate-700/50 bg-slate-950/20 p-3"><div className="mb-2 flex items-center gap-2 text-[10px]"><span className="font-medium text-cyan-200/80">{nameOf(item.agent, agents)}</span><time className="ml-auto text-slate-500" dateTime={item.created_at} title={fullDate(item.created_at)}>{dateValue(item.created_at) ? formatDate(item.created_at) : "Date not recorded"}</time></div><TextDisclosure content={item.content} label="Read experience" /><Link aria-label="Open source investigation" to={`/ai-agents/collaboration?board=${encodeURIComponent(item.task_id)}`} className="mt-3 flex items-center gap-1 text-[10px] text-slate-500 hover:text-cyan-300" title={item.question}><span className="truncate">{excerpt(item.question, 70) || "Source investigation"}</span><ArrowUpRight aria-hidden="true" className="ml-auto h-3 w-3 shrink-0" /></Link></article>)}</div>}
  </Panel>;
}

export function BudgetWidget() {
  const [budget, setBudget] = useState<AIWeeklyBudget | null>(null);
  const [error, setError] = useState(false);
  const [lastPause, setLastPause] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let pending = false;
    async function poll() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try { const value = await api.ai.budget(); if (live) { setBudget(value); setError(false); setLastPause((value.pricing_unknown ?? 0) > 0 ? "Paid AI was paused because some usage had no verified price." : value.exhausted ? "Paid AI was paused because the weekly allowance was exhausted." : null); } }
      catch { if (live) { setBudget(null); setError(true); } }
      finally { pending = false; }
    }
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    const onVisibility = () => { if (document.visibilityState !== "hidden") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [retry]);
  const limit = budget?.limit_usd || 0;
  const priced = budget && (budget.pricing_unknown ?? 0) === 0;
  const billedWidth = budget && limit > 0 ? Math.min(100, Math.max(0, budget.billed_usd / limit * 100)) : 0;
  const reservedWidth = budget && limit > 0 ? Math.min(100 - billedWidth, Math.max(0, budget.reserved_usd / limit * 100)) : 0;
  return <Panel title="Shared weekly budget" icon={Wallet}>
    {!budget && !error && <p className="text-xs text-slate-500">Loading allowance…</p>}
    {budget && <><div className="flex items-baseline justify-between gap-2"><span className="text-xl font-semibold tabular-nums tracking-tight text-slate-100">{money(budget.remaining_usd)}<span className="ml-1.5 text-[10px] font-normal tracking-normal text-slate-500">remaining</span></span><span className="text-[10px] text-slate-500">of {money(budget.limit_usd)}</span></div>
      <div role="progressbar" aria-label="Weekly budget used or reserved" aria-valuemin={0} aria-valuemax={budget.limit_usd} aria-valuenow={Math.min(budget.limit_usd, budget.billed_usd + budget.reserved_usd)} className="my-3 flex h-1.5 overflow-hidden rounded-full bg-slate-800"><span className="h-full bg-cyan-400" style={{ width: `${billedWidth}%` }} /><span className="h-full bg-amber-400/90" style={{ width: `${reservedWidth}%` }} /></div>
      <dl className="grid grid-cols-2 gap-3 text-[10px]"><div><dt className="text-slate-500">Estimated spend</dt><dd className="mt-1 font-mono text-slate-300">{money(budget.billed_usd)}</dd></div><div className="text-right"><dt className="text-slate-500">Reserved</dt><dd className="mt-1 font-mono text-slate-300">{money(budget.reserved_usd)}</dd></div></dl>
      {!priced ? <p role="alert" className="mt-3 text-xs leading-relaxed text-amber-300">Paid AI is paused. Some usage has no verified price.</p> : budget.exhausted ? <p role="alert" className="mt-3 text-xs leading-relaxed text-amber-300">Allowance exhausted. New paid calls are paused until reset.</p> : budget.warning && <p role="alert" className="mt-3 text-xs leading-relaxed text-amber-300">Budget running low. {money(budget.remaining_usd)} remains after reservations.</p>}
      <details className="group mt-3 border-t border-slate-700/50 pt-2.5"><summary className="flex cursor-pointer list-none items-center justify-between rounded-sm text-[10px] text-slate-500 outline-none hover:text-slate-300 focus-visible:ring-2 focus-visible:ring-cyan-400">All agents share this allowance<ChevronDown aria-hidden="true" className="h-3 w-3 group-open:rotate-180" /></summary><div className="mt-2 space-y-2 text-[10px] leading-relaxed text-slate-500"><p>Warning at {money(budget.warning_usd)} used or reserved. Resets {dateValue(budget.reset_at)?.toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" }) || "at the next recorded reset"}.</p><p>Usage is estimated from provider tokens. Reservations include active requests and uncertain outcomes; these values are not an invoice.</p><Link className="inline-flex text-cyan-300 hover:underline" to="/settings?tab=ai">Open AI settings</Link></div></details>
    </>}
    {error && <div role="alert" className="mt-2 text-[10px] leading-relaxed text-amber-300"><p>Budget status is unavailable. The server still enforces the spending limit.</p>{lastPause && <p className="mt-2">Last reported status: {lastPause}</p>}<button type="button" onClick={() => setRetry(value => value + 1)} className="mt-1 rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-cyan-400">Retry refresh</button></div>}
  </Panel>;
}
