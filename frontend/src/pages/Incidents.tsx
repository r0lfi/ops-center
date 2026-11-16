import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { incidents, imCategories, type IMList, type IncidentDetail } from "@/lib/incidents";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
const date = (value: string) => formatDateTime(value);
const label = (value: string) => value.replaceAll("_", " ");
const code = (id: number) => "IM-" + String(id).padStart(6, "0");
export default function Incidents() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [status, setStatus] = useState("open");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<IMList | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError(""); setDetail(null); setList(null);
    async function refresh() {
      try {
        if (id) { const value = await incidents.get(id); if (active) setDetail(value); }
        else { const value = await incidents.list(new URLSearchParams({status, category, q: query, offset: String(offset)})); if (active) setList(value); }
        if (active) setError("");
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : "Incident data is unavailable"); setList(null); setDetail(null); } }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, [id, status, category, query, offset, version]);
  useEffect(() => setNote(""), [id]);
  async function decide(next: string) {
    if (!detail) return;
    setBusy(true); setError("");
    try { await incidents.decide(detail.id, detail.revision, next, note); setNote(""); setVersion(v => v + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not update incident"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold">{id ? detail ? code(detail.id) : "Incident" : "Incidents"}</h1><p className="mt-1 text-sm text-muted-foreground">One incident per problem. Track it here; keep Talk quiet.</p></div><div className="flex gap-3">{id && <Button variant="outline" onClick={() => navigate("/incidents")}>Back to incidents</Button>}{hasRole("admin") && <Link className="text-sm text-primary underline" to="/settings?tab=incidents">incident settings</Link>}</div></div>
    {error && <p role="alert" className="rounded border border-red-400/30 p-3 text-sm text-red-400">{error} <button className="underline" onClick={() => setVersion(v => v + 1)}>Reload</button></p>}
    {!id && <>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">Status <select aria-label="Incident status filter" className="ml-2 rounded border border-border bg-background p-2" value={status} onChange={e => {setStatus(e.target.value); setOffset(0);}}>{["open","all","new","approved","in_progress","completed"].map(v => <option key={v} value={v}>{label(v)}</option>)}</select></label>
        <label className="text-sm">Category <select aria-label="Incident category filter" className="ml-2 rounded border border-border bg-background p-2" value={category} onChange={e => {setCategory(e.target.value); setOffset(0);}}>{["all",...imCategories].map(v => <option key={v} value={v}>{v}</option>)}</select></label>
        <input type="search" aria-label="Search incidents" placeholder="Search problem or resource" value={query} onChange={e => {setQuery(e.target.value); setOffset(0);}} className="min-w-0 rounded border border-border bg-background p-2 text-sm"/>
      </div>
      {list?.workflow_enabled === false && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">The incident workflow is disabled: alerts are sent as Talk notifications only and close automatically after recovery. No automatic investigations run. {hasRole("admin") && <Link className="text-primary underline" to="/settings?tab=incidents">Re-enable in incident settings</Link>}</p>}
      {list && (!list.monitor.checked_at || Date.now()/1000-list.monitor.checked_at > 90 || list.monitor.alertmanager !== "ok") && <p role="status" className="text-sm text-amber-400">Monitoring is unavailable or catching up. Saved incidents remain visible; missing data does not confirm recovery.</p>}
      {list && <p className="text-sm text-muted-foreground">{list.total} incidents match your filters. Completing a task does not hide the underlying alert.</p>}
      <div className="space-y-3">{list?.items.map(item => <Link key={item.id} to={"/incidents/"+item.id} className="block rounded-xl border border-border bg-card p-4 hover:border-primary/50">
        <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm text-primary">{code(item.id)}</span><Badge variant={item.severity === "critical" || item.severity === "high" ? "critical" : "warning"}>{item.severity}</Badge><span className="ml-auto text-xs capitalize">{label(item.status)}</span></div>
        <h2 className="mt-2 font-medium">{item.title}</h2><p className="break-words text-sm text-muted-foreground">{item.resource}</p>
        <p className="mt-3 text-xs text-muted-foreground">Source: {label(item.source_state)} · Last observed {date(item.last_seen)} · {item.observations} observations</p>
      </Link>)}</div>
      {list && list.items.length === 0 && <p className="py-8 text-center text-muted-foreground">No incidents match these filters.</p>}
      {list && <div className="flex items-center gap-3"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-50))}>Previous</Button><span className="text-sm">Page {Math.floor(offset/50)+1}</span><Button variant="outline" disabled={offset+50 >= list.total} onClick={() => setOffset(offset+50)}>Next</Button></div>}
    </>}
    {detail && <>
      <Card><CardContent className="space-y-3 pt-5"><div className="flex flex-wrap gap-3"><Badge>{detail.severity}</Badge><span className="capitalize">{label(detail.status)}</span></div><h2 className="text-xl font-semibold">{detail.title}</h2><p className="break-words font-mono text-sm">{detail.resource}</p><p className="whitespace-pre-wrap text-sm">{String(detail.details.summary || "")}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">{[["Rule",detail.rule],["Category",detail.category],["Source state",label(detail.source_state)],["First observed",date(detail.created_at)],["Last observed",date(detail.last_seen)],["Observations",String(detail.observations)]].map(([k,v]) => <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd>{v}</dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">Talk: {detail.deliveries.length ? detail.deliveries.map(d => d.status).join(", ") : "muted at creation"}. One delivery attempt per incident per room. Unknown delivery is never retried automatically.</p>
      </CardContent></Card>
      {detail.investigation && <Card><CardContent className="space-y-2 pt-5"><h2 className="font-semibold">Agent investigation</h2><p className="text-sm capitalize">{label(detail.investigation.status)} · started {date(detail.investigation.created_at)}</p>{detail.investigation.task_id ? <Link className="text-sm text-primary hover:underline" to={`/ai-agents/tasks?task=${encodeURIComponent(detail.investigation.task_id)}`}>View investigation and findings</Link> : <p className="text-xs text-muted-foreground">The investigation report is private to its owner.</p>}<p className="text-xs text-muted-foreground">Investigation completion does not confirm that the incident is resolved. Operational approval and recovery checks still apply.</p></CardContent></Card>}
      {detail.status === "completed" ? <p role="status" className="rounded border border-emerald-500/30 p-4 text-sm">Completed. Further observations of this ongoing problem stay on this incident and send no new notice. A new incident requires confirmed recovery followed by a new occurrence.</p> : hasRole("operator") && <Card><CardContent className="space-y-3 pt-5">
        <label className="block text-sm">Handling note<textarea aria-label="Handling note" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} className="mt-1 min-h-24 w-full rounded border border-border bg-background p-2"/></label>
        <div className="flex flex-wrap gap-3">{detail.status === "new" && <Button disabled={busy} variant="outline" onClick={() => void decide("approved")}>Approve / acknowledge</Button>}{detail.status !== "in_progress" && <Button disabled={busy} variant="outline" onClick={() => void decide("in_progress")}>Start work</Button>}<Button disabled={busy} onClick={() => void decide("completed")}>Mark completed</Button></div>
        <p className="text-xs text-muted-foreground">These buttons update the incident record. Repairs still require their own operational authorization.</p>
      </CardContent></Card>}
      <Card><CardContent className="pt-5"><h2 className="mb-3 font-semibold">Handling history</h2><ol className="space-y-4">{detail.history.map((event,i) => <li key={i} className="border-l-2 border-primary/30 pl-3 text-sm"><p className="capitalize">{label(event.status)} · {event.actor}</p><p className="text-xs text-muted-foreground">{date(event.created_at)}</p>{event.note && <p className="mt-1 whitespace-pre-wrap">{event.note}</p>}</li>)}</ol></CardContent></Card>
    </>}
    {!error && !(id ? detail : list) && <p role="status" className="text-sm text-muted-foreground">Loading incidents…</p>}
  </div>;
}
