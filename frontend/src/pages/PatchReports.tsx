import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { api, type HostGroup, type PatchReportDetail, type PatchReportSummary } from "@/lib/api";
import { formatDateTime, formatTime } from "@/lib/format";

const TYPES: Record<string, string> = { "patch-security.yml": "Security updates", "patch-all.yml": "All updates", "pihole-update.yml": "Pi-hole update" };
const LABELS: Record<string, string> = { successful: "Successful", failed: "Failed", unreachable: "Unreachable", running: "Running", queued: "Queued", cancelled: "Cancelled", unknown: "Unconfirmed", warning: "Completed with warnings" };
const variant = (status: string) => status === "successful" ? "ok" : ["failed", "unreachable"].includes(status) ? "critical" : ["running", "warning"].includes(status) ? "warning" : "unknown";
const date = (value: string | null) => value ? formatDateTime(value) : "—";
function duration(job: PatchReportSummary) {
  if (!job.started_at) return "Not started";
  const seconds = Math.max(0, Math.floor(((job.finished_at ? new Date(job.finished_at).getTime() : Date.now()) - new Date(job.started_at).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s${job.finished_at ? "" : " so far"}`;
}
function Status({ status }: { status: string }) { return <Badge variant={variant(status)}>{LABELS[status] ?? status}</Badge>; }

export default function PatchReports() {
  const [params, setParams] = useSearchParams();
  const group = params.get("group") || "";
  const status = params.get("status") || "";
  const run = params.get("run") || "";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [data, setData] = useState<{ total: number; items: PatchReportSummary[] } | null>(null);
  const [detail, setDetail] = useState<PatchReportDetail | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState<string | null>(null);

  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("offset"); next.delete("run"); setParams(next);
  }
  useEffect(() => { let live = true; api.hostGroups.list().then(value => { if (live) setGroups(value); }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setData(null); setError("");
    async function load() {
      try {
        const value = await api.patching.reports({ group, status, offset });
        if (live) { setData(value); setError(""); setUpdated(new Date().toISOString()); }
      } catch (err) { if (live) setError(err instanceof Error ? err.message : "Could not load reports"); }
      finally { if (live) timer = setTimeout(load, 15000); }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [group, status, offset, refresh]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null); setDetailError("");
    if (!run) return;
    async function load() {
      try {
        const value = await api.patching.report(run);
        if (live) { setDetail(value); setDetailError(""); }
      } catch (err) { if (live) setDetailError(err instanceof Error ? err.message : "Could not load report details"); }
      finally { if (live) timer = setTimeout(load, 10000); }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [run, refresh]);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64"><PageHeader title="Patch reports" back={{ to: "/patching", label: "Patching" }} description="Results from scheduled and manual patch runs, including Pi-hole updates." /></div>
      <Button variant="outline" onClick={() => setRefresh(v => v + 1)}><RefreshCw className="mr-2 h-4 w-4"/>Refresh</Button>
    </div>
    <Card><CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-52 flex-1 space-y-1 text-xs text-muted-foreground">Patch group<Select aria-label="Patch group" value={group} onChange={e => filter("group", e.target.value)}><option value="">All groups and individual hosts</option>{group && !groups.some(g => g.name === group) && <option value={group}>{group} (historical)</option>}{groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}</Select></label>
        <label className="min-w-40 space-y-1 text-xs text-muted-foreground">Run status<Select aria-label="Run status" value={status} onChange={e => filter("status", e.target.value)}><option value="">All statuses</option>{["successful", "failed", "running", "queued", "cancelled"].map(s => <option key={s} value={s}>{LABELS[s]}</option>)}</Select></label>
        <span className="pb-2 text-xs text-muted-foreground">Auto-refresh · {updated ? `Updated ${formatTime(updated)}` : "Loading…"}</span>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">Could not refresh reports: {error}. Previously loaded results may be out of date.</p>}
      {!data && !error && <p className="py-8 text-center text-sm text-muted-foreground">Loading patch history…</p>}
      {data && <>
        <div className="overflow-x-auto"><table className="ops-card-table w-full text-left text-sm"><thead><tr className="ops-card-table border-b border-border text-xs text-muted-foreground">{["Started / submitted", "Patch group / target", "Update type", "Result", "Hosts: OK / failed / unreachable", "Changed hosts", "Duration"].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>
          {data.items.map(job => <tr key={job.id} onClick={() => { const next = new URLSearchParams(params); next.set("run", job.id); setParams(next); }} className={`cursor-pointer border-b border-border ${run === job.id ? "bg-accent" : "hover:bg-accent/50"}`}>
            <td data-label="Started / submitted" className="whitespace-nowrap px-3 py-3 text-xs">{date(job.started_at || job.created_at)}</td>
            <td data-label="Patch group / target" className="px-3 py-3"><button className="text-left font-medium text-primary hover:underline" onClick={() => { const next = new URLSearchParams(params); next.set("run", job.id); setParams(next); }}>{job.target_description}</button><div className="mt-1 text-xs text-muted-foreground">Run {job.id.slice(0, 8)}</div></td>
            <td data-label="Update type" className="px-3 py-3">{TYPES[job.playbook]}</td><td data-label="Result" className="px-3 py-3"><Status status={job.status}/></td>
            <td data-label="Hosts: OK / failed / unreachable" className="px-3 py-3"><span className="text-status-ok">{job.successful_hosts}</span> / <span className={job.failed_hosts ? "text-status-critical" : ""}>{job.failed_hosts}</span> / <span className={job.unreachable_hosts ? "text-status-critical" : ""}>{job.unreachable_hosts}</span></td>
            <td data-label="Changed hosts" className="px-3 py-3">{job.changed_hosts}</td><td data-label="Duration" className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{duration(job)}</td>
          </tr>)}
          {!data.items.length && <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No patch runs found{group || status ? " for these filters" : " yet"}. Results appear here after a patch run is submitted.</td></tr>}
        </tbody></table></div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{data.total} runs · {data.items.length ? `${offset + 1}–${offset + data.items.length}` : "0 shown"}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(Math.max(0, offset - 25))); setParams(next); }}>Previous</Button><Button size="sm" variant="outline" disabled={offset + 25 >= data.total} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(offset + 25)); setParams(next); }}>Next</Button></div></div>
        <p className="text-xs text-muted-foreground">Host totals are finalized when the run finishes. Changed hosts are not a count of installed packages. Availability scans are excluded.</p>
      </>}
    </CardContent></Card>
    <Dialog open={!!run} onOpenChange={open => { if (!open) { const next = new URLSearchParams(params); next.delete("run"); setParams(next); } }}>
      <DialogContent className="max-h-[92dvh] max-w-5xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader><DialogTitle>{detail ? detail.job.target_description : "Run details"}</DialogTitle></DialogHeader>
        {detailError && <p role="alert" className="text-sm text-destructive">Could not refresh details: {detailError}</p>}
        {!detail && !detailError && <p className="text-sm text-muted-foreground">Loading results…</p>}
        {detail && <RunDetail detail={detail}/>}
      </DialogContent>
    </Dialog>
  </div>;
}

const PACKAGE_REPORT_SINCE = "2026-09-23";

function RunDetail({ detail }: { detail: PatchReportDetail }) {
  const [query, setQuery] = useState("");
  const job = detail.job;
  const reported = detail.hosts.some(h => h.packages);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3"><Status status={job.status}/><span className="text-sm text-muted-foreground">{TYPES[job.playbook]} · Run {job.id.slice(0, 8)}{job.user ? ` · started by ${job.user}` : ""}</span></div>
    <div className="grid gap-3 text-xs sm:grid-cols-4">
      <div className="rounded-md bg-accent/50 p-3">Started<div className="mt-1 font-medium">{date(job.started_at)}</div></div>
      <div className="rounded-md bg-accent/50 p-3">Finished<div className="mt-1 font-medium">{date(job.finished_at)}</div></div>
      <div className="rounded-md bg-accent/50 p-3">Duration<div className="mt-1 font-medium">{duration(job)}</div></div>
      <div className="rounded-md bg-accent/50 p-3">Hosts OK / failed / unreachable<div className="mt-1 font-medium">{job.successful_hosts} / {job.failed_hosts} / {job.unreachable_hosts}</div></div>
    </div>
    {detail.hosts.map(host => {
      const packages = (host.packages ?? []).filter(p => !query || p.name.includes(query.toLowerCase()));
      return <section key={host.host} className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{host.host}</h3><Status status={host.status}/>
          {host.packages && <Badge variant="secondary">{host.packages.length} package change{host.packages.length === 1 ? "" : "s"}</Badge>}
          {host.reboot_required === "yes" && <Badge variant="warning">Reboot required</Badge>}
          {host.reboot_required === "no" && <Badge variant="ok">No reboot needed</Badge>}
          {host.changed != null && <span className="text-xs text-muted-foreground">{host.changed} changed task{host.changed === 1 ? "" : "s"}</span>}</div>
        {host.message && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-status-critical/30 bg-status-critical/5 p-2 text-xs text-status-critical">{host.message}</pre>}
        {host.tasks && host.tasks.length > 0 && <div><p className="mb-1 text-xs font-medium text-muted-foreground">What was performed</p>
          <ol className="space-y-0.5 text-sm">{host.tasks.map((t, i) => <li key={i} className="flex items-center gap-2">
            <span className={"w-16 shrink-0 text-xs font-medium " + (t.result === "changed" ? "text-status-warning" : t.result === "failed" || t.result === "unreachable" ? "text-status-critical" : t.result === "skipped" ? "text-muted-foreground" : "text-status-ok")}>{t.result}</span>
            <span className={t.result === "skipped" ? "text-muted-foreground" : ""}>{t.task}</span></li>)}</ol></div>}
        {host.packages && host.packages.length > 0 && <div className="space-y-2">
          <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium text-muted-foreground">Package changes</p>
            {host.packages.length > 15 && <input aria-label="Filter packages" value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter packages…" className="rounded-md border border-border bg-background px-2 py-1 text-xs"/>}</div>
          <div className="max-h-80 overflow-auto rounded-md border border-border"><table className="ops-card-table w-full text-left text-xs"><thead className="sticky top-0 bg-card"><tr className="border-b border-border text-muted-foreground"><th className="px-3 py-2 font-medium">Package</th><th className="px-3 py-2 font-medium">Before</th><th className="px-3 py-2 font-medium">After</th></tr></thead>
            <tbody>{packages.map(p => <tr key={p.name} className="border-b border-border/50 last:border-0"><td data-label="Package" className="px-3 py-1.5 font-medium">{p.name}</td>
              <td data-label="Before" className="px-3 py-1.5 font-mono text-muted-foreground">{p.from || <span className="italic">not installed</span>}</td>
              <td data-label="After" className="px-3 py-1.5 font-mono">{p.to || <span className="italic text-status-warning">removed</span>}</td></tr>)}</tbody></table></div></div>}
        {host.packages && host.packages.length === 0 && <p className="text-sm text-muted-foreground">No package versions changed on this host.</p>}
        {host.output && <div><p className="mb-1 text-xs font-medium text-muted-foreground">Output</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-xs">{formatOutput(host.output)}</pre></div>}
      </section>;
    })}
    {!detail.hosts.length && <p className="text-sm text-muted-foreground">No per-host results recorded. Check the run log for startup errors or pending execution.</p>}
    {!reported && job.playbook !== "pihole-update.yml" && <p className="text-xs text-muted-foreground">Package-level changes are recorded for patch runs from {PACKAGE_REPORT_SINCE} onwards; this run shows the tasks and the log.</p>}
    <p className="text-xs text-muted-foreground">Host outcomes use the final Ansible recap. Missing final results are unconfirmed. Cancelled runs do not confirm completion.</p>
    <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Full run log ({job.events.length} events)</summary><div className="mt-3 max-h-96 overflow-auto rounded bg-background p-3 font-mono text-xs">{!job.events.length && <p>No log events recorded yet.</p>}{job.events.filter(e => !(e.message ?? "").startsWith("OPS_CENTER_PACKAGE_CHANGES:")).map(event => <div key={event.sequence} className="mb-2 whitespace-pre-wrap break-words"><span className="text-muted-foreground">{date(event.created_at)} </span>{event.host && <span className="text-primary">[{event.host}] </span>}<span>{event.task && `${event.task}: `}{event.message || event.event_type}</span></div>)}</div></details>
    <Link className="inline-block text-sm text-primary hover:underline" to={`/jobs/${job.id}`}>Open full job</Link>
  </div>;
}

function formatOutput(raw: string) {
  try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.join("\n") : JSON.stringify(value, null, 2); } catch { return raw; }
}
