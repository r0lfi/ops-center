import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, CircleDot, Code2, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { DevChangeDetailPanel } from "@/components/ai/DevChangeDetail";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type DevChange, type DevOverview, type DevStage } from "@/lib/api";
import { useAskOpsPageContext } from "@/lib/askOps";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Variant = "ok" | "warning" | "critical" | "unknown" | "secondary" | "default";
export const STAGE: Record<DevStage, { label: string; variant: Variant }> = {
  proposed: { label: "Proposed", variant: "unknown" },
  working: { label: "Working", variant: "default" },
  ready_for_review: { label: "Ready for Review", variant: "warning" },
  changes_requested: { label: "Changes requested", variant: "warning" },
  approved: { label: "Approved", variant: "ok" },
  in_production: { label: "In Production", variant: "ok" },
  rejected: { label: "Rejected", variant: "unknown" },
  failed: { label: "Failed", variant: "critical" },
  rolled_back: { label: "Rolled back", variant: "critical" },
};

const FILTERS: { key: string; label: string; stages: DevStage[]; hint: string }[] = [
  { key: "review", label: "Needs your review", stages: ["ready_for_review"], hint: "Finished patches waiting for a decision" },
  { key: "active", label: "In progress", stages: ["working", "proposed", "changes_requested"], hint: "Working now or waiting to start" },
  { key: "approved", label: "Approved", stages: ["approved"], hint: "Approved, not yet released" },
  { key: "production", label: "In production", stages: ["in_production"], hint: "Release recorded" },
  { key: "failed", label: "Failed & rejected", stages: ["failed", "rejected", "rolled_back"], hint: "Stopped, refused or rolled back" },
];

function Row({ item, open, onToggle, canDecide, onChanged }: { item: DevChange; open: boolean; onToggle: () => void; canDecide: boolean; onChanged: () => void }) {
  const stage = STAGE[item.stage] ?? { label: item.stage, variant: "unknown" as const };
  const run = item.developer_run;
  return (
    <li className={cn("overflow-hidden rounded-lg border bg-card transition-colors", open ? "border-primary/40" : "border-border hover:border-primary/30")}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
        <span className="mt-0.5 flex w-28 shrink-0 sm:w-36">
          <Badge variant={stage.variant} className="gap-1">
            {item.stage === "working" && <CircleDot className="h-3 w-3 animate-pulse motion-reduce:animate-none" aria-hidden="true" />}{stage.label}
          </Badge>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{item.title}</span>
          {item.summary && <span className="line-clamp-1 block text-xs text-muted-foreground">{item.summary}</span>}
          <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {item.files > 0 && <span><Code2 className="mr-1 inline h-3 w-3" aria-hidden="true" />{item.files} file{item.files === 1 ? "" : "s"} <span className="text-status-ok">+{item.added}</span> <span className="text-status-critical">−{item.removed}</span></span>}
            {item.proposed_by && <span>proposed by {item.proposed_by}</span>}
            {run && <span>{run.status === "running" ? "started" : "ran"} {formatRelativeTime(run.started_at ?? run.created_at)}{item.runs > 1 ? ` · ${item.runs} runs` : ""}</span>}
            {item.approved_by && <span>approved by {item.approved_by}</span>}
            {item.release_ref && <span className="font-mono">{item.release_ref}</span>}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{formatRelativeTime(item.updated_at)}</span>
        <ChevronDown className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <DevChangeDetailPanel id={item.id} canDecide={canDecide} onChanged={onChanged} />}
    </li>
  );
}

/** AI > Developer Agent: what it is working on, what it built, what needs a decision and what is in production. */
export default function AIDeveloper() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<DevOverview | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const openId = params.get("change");
  const filter = params.get("show") ?? (openId ? "all" : "");

  const load = useCallback(() => api.ai.developer.overview().then(d => { setData(d); setError(""); })
    .catch(e => setError(e instanceof Error ? e.message : "Failed to load")), []);
  const working = !!data?.items.some(i => i.stage === "working");
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, working ? 4000 : 15000);
    return () => clearInterval(timer);
  }, [load, working]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.key, f.stages.reduce((n, s) => n + (data?.counts[s] ?? 0), 0)])), [data]);
  // Default view: what needs you, else what is moving, else everything.
  const active = filter || (counts.review ? "review" : counts.active ? "active" : "all");
  const shown = useMemo(() => {
    const stages = FILTERS.find(f => f.key === active)?.stages;
    const q = query.trim().toLowerCase();
    return (data?.items ?? []).filter(i => (!stages || stages.includes(i.stage) || i.id === openId) && (!q || i.title.toLowerCase().includes(q) || i.summary.toLowerCase().includes(q)));
  }, [data, active, query, openId]);

  const set = (key: string, value: string | null) => setParams(prev => {
    const next = new URLSearchParams(prev);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const agent = data?.agent;
  const selected = data?.items.find(i => i.id === openId);
  useAskOpsPageContext([
    selected && { label: "Selected change", value: `${selected.title} (proposal ${selected.id})` },
    selected && { label: "Change status", value: STAGE[selected.stage]?.label ?? selected.stage },
    { label: "Shown", value: FILTERS.find(f => f.key === active)?.label ?? "All changes" },
  ]);
  return (
    <div className="space-y-4">
      <PageHeader title="Developer Agent"
        description="What the Developer Agent is working on, what it built, and what needs your approval before production. Approval deploys nothing; only an approved patch can be recorded as released." />

      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span className={cn("h-2.5 w-2.5 rounded-full", agent?.status === "working" ? "animate-pulse bg-primary motion-reduce:animate-none" : agent?.enabled ? "bg-status-ok" : "bg-status-unknown")} aria-hidden="true" />
        <span className="text-sm font-medium">{agent?.name ?? "Developer Agent"}</span>
        <span className="text-sm text-muted-foreground">
          {!data ? "Loading…" : !agent ? "Not installed" : !agent.enabled ? "Disabled" : !agent.configured ? "No model provider configured"
            : agent.status === "working" ? (agent.activity || "Working") : "Idle"}
        </span>
      </Card>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" role="tablist" aria-label="Filter changes">
        {FILTERS.map(f => (
          <button key={f.key} type="button" role="tab" aria-selected={active === f.key} title={f.hint}
            onClick={() => set("show", active === f.key ? "all" : f.key)}
            className={cn("rounded-lg border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active === f.key ? "border-primary/60 bg-primary/5" : "border-border hover:border-primary/30")}>
            <span className="block text-xs text-muted-foreground">{f.label}</span>
            <span className={cn("mt-1 block text-2xl font-semibold tabular-nums", f.key === "review" && counts[f.key] > 0 && "text-status-warning")}>{data ? counts[f.key] : "–"}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search changes" placeholder="Search changes" value={query} onChange={e => setQuery(e.target.value)} className="pl-8" />
        </div>
        <button type="button" onClick={() => set("show", "all")} className={cn("rounded-md px-3 py-2 text-sm", active === "all" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>
          All ({data?.items.length ?? 0})
        </button>
      </div>

      {data && shown.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {data.items.length === 0 ? "The Developer Agent has no changes yet. It starts when an admin approves a tool proposal for development." : "Nothing here."}
        </p>
      )}
      <ul className="space-y-2">
        {shown.map(item => (
          <Row key={item.id} item={item} open={openId === item.id} canDecide={data!.can_decide} onChanged={() => void load()}
            onToggle={() => set("change", openId === item.id ? null : item.id)} />
        ))}
      </ul>
    </div>
  );
}
