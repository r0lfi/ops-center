import { useMemo, useState, type FormEvent } from "react";
import { Download, Pause, Play } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";
import {
  OUTCOMES, action, aiTraffic, bytesOf, destination, downloadFile, formatMs, formatTimeMs,
  type EventFilters, type TrafficEvent,
} from "@/lib/aiTraffic";
import { useAuth } from "@/lib/auth";
import { ErrorNote, EventDetailDialog, OutcomeBadge, WINDOWS, errorText, usePoll } from "./common";

const FILTER_FIELDS: { key: keyof EventFilters; label: string; placeholder: string }[] = [
  { key: "agent", label: "Agent", placeholder: "monitoring" },
  { key: "model", label: "Model", placeholder: "mistral-large-latest" },
  { key: "tool", label: "Tool", placeholder: "web_fetch" },
  { key: "host", label: "Domain", placeholder: "api.mistral.ai" },
  { key: "ip", label: "IP", placeholder: "203.0.113.5" },
  { key: "port", label: "Port", placeholder: "443" },
  { key: "process", label: "Process", placeholder: "celery worker" },
  { key: "container", label: "Container", placeholder: "ops-center-ai-worker" },
  { key: "node", label: "Node", placeholder: "docker-host-01" },
  { key: "trace_id", label: "Trace", placeholder: "trace id" },
];
const PAGE = 100;

/** Live, filterable event table; also used with a preset status for the Blocked & Failed view. */
export function EventTable({ events, onOpen }: { events: TrafficEvent[]; onOpen: (id: number) => void }) {
  const showDate = events.length > 0 && formatDate(events[0].ts) !== formatDate(events[events.length - 1].ts);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            {["Time", "Agent", "Model / process", "Destination", "Protocol", "Action", "Status", "Data", "Duration"].map(h => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map(e => {
            const bytes = bytesOf(e);
            return (
              <tr key={e.id} tabIndex={0} onClick={() => onOpen(e.id)} onKeyDown={k => (k.key === "Enter" || k.key === " ") && (k.preventDefault(), onOpen(e.id))}
                className="cursor-pointer border-b border-border/60 hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none" aria-label={`Open ${action(e)} to ${destination(e)}`}>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums">{showDate && <span className="text-muted-foreground">{formatDate(e.ts)} </span>}{formatTimeMs(e.ts)}</td>
                <td className="px-3 py-1.5">{e.agent_slug ?? <span className="text-muted-foreground">—</span>}{e.tool && <span className="block text-xs text-muted-foreground">{e.mcp_tool ? "MCP " : ""}{e.tool}</span>}</td>
                <td className="max-w-[180px] truncate px-3 py-1.5 text-xs" title={e.model ?? e.process ?? ""}>{e.model ?? e.process ?? e.container ?? "—"}</td>
                <td className="max-w-[260px] truncate px-3 py-1.5 font-mono text-xs" title={`${e.dst_host ?? ""} ${e.dst_ip ?? ""}`}>{destination(e)}</td>
                <td className="px-3 py-1.5 text-xs">{e.protocol ?? e.kind}</td>
                <td className="max-w-[180px] truncate px-3 py-1.5 font-mono text-xs" title={action(e)}>{action(e)}</td>
                <td className="px-3 py-1.5"><OutcomeBadge outcome={e.outcome} />{e.status_code ? <span className="ml-1 text-xs text-muted-foreground">{e.status_code}</span> : null}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums">{bytes === null ? "—" : formatBytes(bytes)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums">{(e.kind === "tcp" || e.kind === "udp") && !e.ended_at ? <span className="text-primary">open</span> : formatMs(e.duration_ms)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LiveView() {
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = useMemo<EventFilters>(() => {
    const f: EventFilters = { window: params.get("window") || "1h" };
    for (const key of ["agent", "model", "tool", "host", "ip", "port", "process", "container", "node", "trace_id", "task_id", "status", "kind", "q"] as const) {
      const v = params.get(key);
      if (v) f[key] = v;
    }
    return f;
  }, [params]);
  const [live, setLive] = useState(true);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ events: TrafficEvent[]; total: number | null; total_capped: boolean } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [exportError, setExportError] = useState("");
  const error = usePoll(async () => {
    if (!hasRole("operator")) return;
    if (!live && data && page === 0) return;
    setData(await aiTraffic.events(filters, { limit: PAGE, offset: page * PAGE }));
  }, live && page === 0 ? 3000 : 3_600_000, [filters, live, page]);

  function update(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setPage(0);
    setParams(p, { replace: true });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update(Object.fromEntries(["q", ...FILTER_FIELDS.map(f => f.key)].map(k => [k, String(form.get(k) ?? "").trim()])));
  }

  async function exportAs(format: "csv" | "json") {
    setExportError("");
    try { await downloadFile(aiTraffic.exportUrl(filters, format), `ai-traffic.${format}`); }
    catch (e) { setExportError(errorText(e)); }
  }

  if (!hasRole("operator")) return <p className="text-sm text-muted-foreground">Connection details need the operator role.</p>;
  const active = Object.entries(filters).filter(([k]) => k !== "window");

  return (
    <div className="space-y-3">
      <form key={params.toString()} onSubmit={submit} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">Search all fields
            <Input name="q" defaultValue={filters.q ?? ""} placeholder="domain, IP, agent, tool, reason…" className="mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">Window
            <Select aria-label="Time window" value={filters.window} onChange={e => update({ window: e.target.value })} className="mt-1 w-32">
              {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">Status
            <Select aria-label="Status" value={filters.status ?? ""} onChange={e => update({ status: e.target.value })} className="mt-1 w-44">
              <option value="">Any</option>
              <option value="problem">Not OK</option>
              <option value="failed">Failed</option>
              <option value="blocked">Blocked</option>
              {Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">Type
            <Select aria-label="Event type" value={filters.kind ?? ""} onChange={e => update({ kind: e.target.value })} className="mt-1 w-32">
              <option value="">Any</option>
              <option value="http">HTTP</option><option value="tcp">TCP</option><option value="udp">UDP</option>
              <option value="dns">DNS</option><option value="access">AI access</option>
            </Select>
          </label>
          <Button type="submit" size="sm" className="h-9">Apply</Button>
        </div>
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">More filters{active.length ? ` (${active.length} active)` : ""}</summary>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {FILTER_FIELDS.map(f => (
              <label key={f.key} className="text-xs text-muted-foreground">{f.label}
                <Input name={f.key} defaultValue={filters[f.key] ?? ""} placeholder={f.placeholder} className="mt-1 h-8" />
              </label>
            ))}
          </div>
        </details>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Button type="button" size="sm" variant="outline" onClick={() => { setLive(v => !v); setPage(0); }} aria-pressed={live}>
            {live ? <Pause className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}{live ? "Pause" : "Resume live"}
          </Button>
          <span>{data?.total == null ? "" : `${formatNumber(data.total)}${data.total_capped ? "+" : ""} matching`}{live && page === 0 ? " · updating every 3 s" : ""}</span>
          {active.map(([k, v]) => (
            <button key={k} type="button" onClick={() => update({ [k]: "" })} className="rounded bg-secondary px-1.5 py-0.5 hover:bg-accent" aria-label={`Remove filter ${k}`}>
              {k}: {v} ×
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void exportAs("csv")}><Download className="mr-1 h-3 w-3" />CSV</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void exportAs("json")}><Download className="mr-1 h-3 w-3" />JSON</Button>
        </div>
      </div>
      <ErrorNote error={error || exportError} />
      <Card>
        <CardContent className="p-0">
          {!data ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p>
            : data.events.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No events match. That covers only the sources that are reporting; see Capture &amp; Sources for coverage.</p>
            : <EventTable events={data.events} onOpen={setOpen} />}
        </CardContent>
      </Card>
      {data && (data.events.length === PAGE || page > 0) && (
        <div className="flex items-center justify-end gap-2 text-xs">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Newer</Button>
          <span className="text-muted-foreground">Page {page + 1}</span>
          <Button size="sm" variant="outline" disabled={data.events.length < PAGE} onClick={() => { setLive(false); setPage(p => p + 1); }}>Older</Button>
        </div>
      )}
      <EventDetailDialog eventId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
