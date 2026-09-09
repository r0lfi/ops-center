import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, ClipboardList, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api, type HostGroup, type PatchReportDetail, type PatchReportSummary } from "@/lib/api";

const TYPES: Record<string, string> = { "patch-security.yml": "Security updates", "patch-all.yml": "All updates", "pihole-update.yml": "Pi-hole update" };
const LABELS: Record<string, string> = { successful: "Successful", failed: "Failed", unreachable: "Unreachable", running: "Running", queued: "Queued", cancelled: "Cancelled", unknown: "Unconfirmed", warning: "Completed with warnings" };
const variant = (status: string) => status === "successful" ? "ok" : ["failed", "unreachable"].includes(status) ? "critical" : ["running", "warning"].includes(status) ? "warning" : "unknown";
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
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
      <div><Link to="/patching" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"><ArrowLeft className="h-3 w-3"/>Patching</Link><h1 className="flex items-center gap-2 text-2xl font-semibold"><ClipboardList className="h-6 w-6 text-primary"/>Patch reports</h1><p className="mt-1 text-sm text-muted-foreground">Results from scheduled and manual patch runs, including Pi-hole updates.</p></div>
      <Button variant="outline" onClick={() => setRefresh(v => v + 1)}><RefreshCw className="mr-2 h-4 w-4"/>Refresh</Button>
    </div>
    <Card><CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-52 flex-1 space-y-1 text-xs text-muted-foreground">Patch group<Select aria-label="Patch group" value={group} onChange={e => filter("group", e.target.value)}><option value="">All groups and individual hosts</option>{group && !groups.some(g => g.name === group) && <option value={group}>{group} (historical)</option>}{groups.map(g => <option key={g.id} value={g.name}>{g.name}</option>)}</Select></label>
        <label className="min-w-40 space-y-1 text-xs text-muted-foreground">Run status<Select aria-label="Run status" value={status} onChange={e => filter("status", e.target.value)}><option value="">All statuses</option>{["successful", "failed", "running", "queued", "cancelled"].map(s => <option key={s} value={s}>{LABELS[s]}</option>)}</Select></label>
        <span className="pb-2 text-xs text-muted-foreground">Auto-refresh · {updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : "Loading…"}</span>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">Could not refresh reports: {error}. Previously loaded results may be out of date.</p>}
      {!data && !error && <p className="py-8 text-center text-sm text-muted-foreground">Loading patch history…</p>}
      {data && <>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground">{["Started / submitted", "Patch group / target", "Update type", "Result", "Hosts: OK / failed / unreachable", "Changed hosts", "Duration"].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>
          {data.items.map(job => <tr key={job.id} className={`border-b border-border ${run === job.id ? "bg-accent" : "hover:bg-accent/50"}`}>
            <td className="whitespace-nowrap px-3 py-3 text-xs">{date(job.started_at || job.created_at)}</td>
            <td className="px-3 py-3"><button className="text-left font-medium text-primary hover:underline" onClick={() => { const next = new URLSearchParams(params); next.set("run", job.id); setParams(next); }}>{job.target_description}</button><div className="mt-1 text-xs text-muted-foreground">Run {job.id.slice(0, 8)}</div></td>
            <td className="px-3 py-3">{TYPES[job.playbook]}</td><td className="px-3 py-3"><Status status={job.status}/></td>
            <td className="px-3 py-3"><span className="text-status-ok">{job.successful_hosts}</span> / <span className={job.failed_hosts ? "text-status-critical" : ""}>{job.failed_hosts}</span> / <span className={job.unreachable_hosts ? "text-status-critical" : ""}>{job.unreachable_hosts}</span></td>
            <td className="px-3 py-3">{job.changed_hosts}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{duration(job)}</td>
          </tr>)}
          {!data.items.length && <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">No patch runs found{group || status ? " for these filters" : " yet"}. Results appear here after a patch run is submitted.</td></tr>}
        </tbody></table></div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{data.total} runs · {data.items.length ? `${offset + 1}–${offset + data.items.length}` : "0 shown"}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(Math.max(0, offset - 25))); setParams(next); }}>Previous</Button><Button size="sm" variant="outline" disabled={offset + 25 >= data.total} onClick={() => { const next = new URLSearchParams(params); next.set("offset", String(offset + 25)); setParams(next); }}>Next</Button></div></div>
        <p className="text-xs text-muted-foreground">Host totals are finalized when the run finishes. Changed hosts are not a count of installed packages. Availability scans are excluded.</p>
      </>}
    </CardContent></Card>
    {run && <Card><CardContent className="space-y-4 pt-4">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Run details</h2><Button size="sm" variant="outline" onClick={() => { const next = new URLSearchParams(params); next.delete("run"); setParams(next); }}>Close</Button></div>
      {detailError && <p role="alert" className="text-sm text-destructive">Could not refresh details: {detailError}</p>}
      {!detail && !detailError && <p className="text-sm text-muted-foreground">Loading results…</p>}
      {detail && <>
        <div className="flex flex-wrap items-center gap-3"><Status status={detail.job.status}/><span className="font-medium">{detail.job.target_description}</span><span className="text-sm text-muted-foreground">{TYPES[detail.job.playbook]}</span></div>
        <div className="grid gap-3 text-xs sm:grid-cols-3"><div className="rounded-md bg-accent/50 p-3">Started<div className="mt-1 font-medium">{date(detail.job.started_at)}</div></div><div className="rounded-md bg-accent/50 p-3">Finished<div className="mt-1 font-medium">{date(detail.job.finished_at)}</div></div><div className="rounded-md bg-accent/50 p-3">Duration<div className="mt-1 font-medium">{duration(detail.job)}</div></div></div>
        <h3 className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4"/>Host results</h3>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground">{["Host", "Result", "Changed tasks", "Last task / error"].map(label => <th key={label} className="px-3 py-2 font-medium">{label}</th>)}</tr></thead><tbody>{detail.hosts.map(host => <tr key={host.host} className="border-b border-border"><td className="px-3 py-3 font-medium">{host.host}</td><td className="px-3 py-3"><Status status={host.status}/></td><td className="px-3 py-3">{host.changed ?? "—"}</td><td className="max-w-xl px-3 py-3 text-xs"><div>{host.last_task || "—"}</div>{host.message && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-status-warning">{host.message}</pre>}</td></tr>)}{!detail.hosts.length && <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No per-host results recorded. Check the run log for startup errors or pending execution.</td></tr>}</tbody></table></div>
        <p className="text-xs text-muted-foreground">Host outcomes use the final Ansible recap. Missing final results are unconfirmed. Hosts never reached by the run may not appear. Cancelled runs do not confirm completion.</p>
        <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Run log ({detail.job.events.length} events)</summary><div className="mt-3 max-h-96 overflow-auto rounded bg-background p-3 font-mono text-xs">{!detail.job.events.length && <p>No log events recorded yet.</p>}{detail.job.events.map(event => <div key={event.sequence} className="mb-2 whitespace-pre-wrap break-words"><span className="text-muted-foreground">{date(event.created_at)} </span>{event.host && <span className="text-primary">[{event.host}] </span>}<span>{event.task && `${event.task}: `}{event.message || event.event_type}</span></div>)}</div></details>
        <Link className="inline-block text-sm text-primary hover:underline" to={`/jobs/${detail.job.id}`}>Open full job</Link>
      </>}
    </CardContent></Card>}
  </div>;
}
