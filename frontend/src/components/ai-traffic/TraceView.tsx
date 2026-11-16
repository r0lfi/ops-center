import { useEffect, useMemo, useState } from "react";
import { Bot, Brain, Globe, MessageSquare, Wrench, Flag } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDayTime, formatRelativeTime } from "@/lib/format";
import { aiTraffic, destination, formatMs, formatTimeMs, outcomeGroup, type Span, type TraceDetail, type TraceSummary, type TrafficEvent } from "@/lib/aiTraffic";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ErrorNote, EventDetailDialog, OutcomeBadge, WindowSelect, errorText, usePoll } from "./common";

interface Step {
  key: string;
  depth: number;
  at: number;
  kind: "request" | "agent" | "model" | "tool" | "network" | "answer";
  title: string;
  sub?: string;
  duration?: number | null;
  status: "ok" | "failed" | "blocked" | "running";
  event?: TrafficEvent;
  start: number;
  end: number;
}

const ICON = { request: MessageSquare, agent: Bot, model: Brain, tool: Wrench, network: Globe, answer: Flag };
const STATUS_TEXT = { ok: "text-status-ok", failed: "text-status-warning", blocked: "text-status-critical", running: "text-primary" };

/** Flatten spans (a tree) and their network events into one ordered timeline. */
function buildSteps(trace: TraceDetail): Step[] {
  const children = new Map<string | null, Span[]>();
  const ids = new Set(trace.spans.map(s => s.span_id));
  for (const s of trace.spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const eventsBySpan = new Map<string | null, TrafficEvent[]>();
  for (const e of trace.events) {
    const key = e.span_id && ids.has(e.span_id) ? e.span_id : null;
    eventsBySpan.set(key, [...(eventsBySpan.get(key) ?? []), e]);
  }
  const steps: Step[] = [];
  const t0 = Math.min(...trace.spans.map(s => Date.parse(s.started_at)), ...trace.events.map(e => Date.parse(e.ts)));
  if (trace.task) {
    steps.push({ key: "request", depth: 0, at: Date.parse(trace.task.created_at), kind: "request", title: `Request from ${trace.task.source}`,
      sub: trace.task.requested_by ? `by ${trace.task.requested_by}` : undefined, status: "ok", start: t0, end: t0 });
  }
  const eventStep = (e: TrafficEvent, depth: number): Step => {
    const start = Date.parse(e.ts);
    return {
      key: `e${e.id}`, depth, at: start, kind: "network", title: `${e.kind === "access" ? "Refused" : e.method ?? e.protocol?.toUpperCase() ?? e.kind} ${destination(e)}`,
      sub: [e.status_code ? `HTTP ${e.status_code}` : null, e.reason].filter(Boolean).join(" · ") || undefined,
      duration: e.duration_ms, status: outcomeGroup(e.outcome), event: e, start, end: start + (e.duration_ms ?? 0),
    };
  };
  const walk = (parent: string | null, depth: number) => {
    const items: Step[] = [];
    for (const s of children.get(parent) ?? []) {
      const start = Date.parse(s.started_at);
      const attrs = s.attributes ?? {};
      const tokens = attrs["gen_ai.usage.input_tokens"] != null ? `${attrs["gen_ai.usage.input_tokens"]} in / ${attrs["gen_ai.usage.output_tokens"]} out tokens` : undefined;
      items.push({
        key: s.span_id, depth, at: start, kind: (["agent", "model", "tool"].includes(s.kind) ? s.kind : "tool") as Step["kind"],
        title: s.kind === "agent" ? `${s.name} agent` : s.kind === "model" ? s.name.replace(/^chat /, "Model ") : `Tool ${s.name}`,
        sub: [s.kind === "model" ? String(attrs["gen_ai.provider.name"] ?? "") : null, tokens, attrs["ops.approval"] ? "approval requested" : null,
              attrs["error"] ? String(attrs["error"]) : null, attrs["ops.stop_reason"] ? String(attrs["ops.stop_reason"]) : null].filter(Boolean).join(" · ") || undefined,
        duration: s.duration_ms, status: s.status === "running" ? "running" : s.status === "error" ? "failed" : "ok",
        start, end: s.ended_at ? Date.parse(s.ended_at) : start,
      });
    }
    for (const e of eventsBySpan.get(parent) ?? []) items.push(eventStep(e, depth));
    items.sort((a, b) => a.at - b.at);
    for (const item of items) {
      steps.push(item);
      if (!item.event) walk(item.key, depth + 1);
    }
  };
  walk(null, trace.task ? 1 : 0);
  if (trace.task?.completed_at) {
    const at = Date.parse(trace.task.completed_at);
    steps.push({ key: "answer", depth: 0, at, kind: "answer", title: `Final answer (${trace.task.status})`, status: trace.task.status === "completed" ? "ok" : "failed", start: at, end: at });
  }
  return steps;
}

function Timeline({ trace, onOpen }: { trace: TraceDetail; onOpen: (id: number) => void }) {
  const steps = useMemo(() => buildSteps(trace), [trace]);
  const t0 = Math.min(...steps.map(s => s.start));
  const t1 = Math.max(...steps.map(s => s.end), t0 + 1);
  const span = t1 - t0;
  return (
    <ol className="space-y-1" aria-label="Agent trace timeline">
      {steps.map(s => {
        const Icon = ICON[s.kind];
        const left = ((s.start - t0) / span) * 100;
        const width = Math.max(0.6, ((s.end - s.start) / span) * 100);
        const content = (
          <div className="grid grid-cols-1 gap-1 rounded-md p-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,40%)] sm:items-center">
            <div className="flex min-w-0 items-start gap-2" style={{ paddingLeft: `${Math.min(s.depth, 6) * 14}px` }}>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", STATUS_TEXT[s.status])} aria-hidden="true" />
              <div className="min-w-0">
                <p className="break-words text-sm">{s.title}
                  {s.event && s.event.outcome !== "ok" && <OutcomeBadge outcome={s.event.outcome} className="ml-2" />}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatTimeMs(new Date(s.at).toISOString())}{s.duration != null ? ` · ${formatMs(s.duration)}` : s.status === "running" ? " · running" : ""}{s.sub ? ` · ${s.sub}` : ""}
                </p>
              </div>
            </div>
            <div className="relative hidden h-2 rounded bg-secondary sm:block" aria-hidden="true">
              <div className={cn("absolute h-2 rounded", s.status === "blocked" ? "bg-status-critical" : s.status === "failed" ? "bg-status-warning" : s.kind === "network" ? "bg-primary" : "bg-muted-foreground/60")}
                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
            </div>
          </div>
        );
        return (
          <li key={s.key}>
            {s.event ? <button type="button" className="w-full text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md" onClick={() => onOpen(s.event!.id)}>{content}</button> : content}
          </li>
        );
      })}
    </ol>
  );
}

export function TraceView() {
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("trace");
  const [window, setWindow] = useState("24h");
  const [agent, setAgent] = useState("");
  const [list, setList] = useState<TraceSummary[] | null>(null);
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [traceError, setTraceError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const error = usePoll(async () => { if (hasRole("operator")) setList((await aiTraffic.traces(window, agent || undefined)).traces); }, 10000, [window, agent]);
  useEffect(() => {
    setTrace(null); setTraceError("");
    if (!selected) return;
    let live = true;
    const load = () => aiTraffic.trace(selected).then(t => live && setTrace(t)).catch(e => live && setTraceError(errorText(e)));
    void load();
    const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [selected]);
  const agents = useMemo(() => [...new Set((list ?? []).flatMap(t => t.agents ?? []))].sort(), [list]);
  if (!hasRole("operator")) return <p className="text-sm text-muted-foreground">Traces need the operator role.</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Card className="min-w-0">
        <CardHeader className="gap-2">
          <CardTitle>Agent runs</CardTitle>
          <div className="flex flex-wrap gap-2">
            <WindowSelect value={window} onChange={setWindow} label="Window" />
            <select aria-label="Agent" value={agent} onChange={e => setAgent(e.target.value)} className="h-8 rounded-md border border-input bg-secondary px-2 text-xs">
              <option value="">All agents</option>
              {agents.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent className="max-h-[70vh] overflow-y-auto p-2">
          <ErrorNote error={error} />
          {!list ? <p className="p-2 text-sm text-muted-foreground">Loading…</p> : list.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No traced agent runs in this window.</p> : (
            <ul className="space-y-1">
              {list.map(t => (
                <li key={t.trace_id}>
                  <button type="button" onClick={() => setParams({ trace: t.trace_id })} aria-current={t.trace_id === selected}
                    className={cn("w-full rounded-md p-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", t.trace_id === selected && "bg-accent")}>
                    <p className="font-medium">{t.root_agent ?? "agent"}{(t.agents?.length ?? 0) > 1 && <span className="text-muted-foreground"> + {(t.agents?.length ?? 1) - 1}</span>}</p>
                    <p className="text-xs text-muted-foreground">{formatRelativeTime(t.started_at)} · {t.spans} steps · {t.events} network events
                      {t.problems > 0 && <span className="text-status-warning"> · {t.problems} not OK</span>}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>{trace?.task ? `${trace.task.agent_name ?? "Agent"} · ${trace.task.source} · ${formatDayTime(trace.task.created_at)}` : "Timeline"}</CardTitle>
          {trace && <p className="text-xs text-muted-foreground">Trace {trace.trace_id}. Who started what, in order; select a network step for its details. The request and answer text are not stored here.</p>}
        </CardHeader>
        <CardContent>
          <ErrorNote error={traceError} />
          {!selected ? <p className="text-sm text-muted-foreground">Choose an agent run to see its timeline.</p>
            : !trace ? (!traceError && <p className="text-sm text-muted-foreground">Loading…</p>)
            : <Timeline trace={trace} onOpen={setOpen} />}
        </CardContent>
      </Card>
      <EventDetailDialog eventId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
