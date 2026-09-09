import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Boxes, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, type ContainerInfo } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

const PAGE_SIZE = 50;
const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  running: "ok", exited: "unknown", created: "unknown", paused: "warning", restarting: "warning", dead: "critical",
};

export default function AllContainers() {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [host, setHost] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (live) setLoading(true);
      try {
        const rows = await api.containers.list();
        if (live) { setContainers(rows); setError(""); setUpdated(new Date().toISOString()); }
      } catch (err) { if (live) setError(err instanceof Error ? err.message : "Could not load containers"); }
      finally { if (live) { setLoading(false); timer = setTimeout(load, 15000); } }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [refresh]);

  const hosts = useMemo(() => [...new Set((containers ?? []).map(c => c.hostname))].sort(), [containers]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (containers ?? []).filter(c => (!host || c.hostname === host)
      && (!status || (status === "stopped" ? ["exited", "created", "dead"].includes(c.status) : status === "unhealthy" ? c.health === "unhealthy" : c.status === status))
      && (!query || `${c.name} ${c.hostname} ${c.image}`.toLowerCase().includes(query)))
      .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.name.localeCompare(b.name));
  }, [containers, host, status, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const running = (containers ?? []).filter(c => c.status === "running").length;
  const unhealthy = (containers ?? []).filter(c => c.health === "unhealthy").length;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><Link to="/containers" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><ArrowLeft className="h-3 w-3"/>Container hosts</Link><h1 className="flex items-center gap-2 text-2xl font-semibold"><Boxes className="h-6 w-6 text-primary"/>All containers</h1><p className="mt-1 text-sm text-muted-foreground">Running and stopped containers across all hosts in the Ops Center inventory.</p></div>
      <Button variant="outline" disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}/>{loading ? "Refreshing…" : "Refresh"}</Button>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[["Containers", containers?.length], ["Hosts with containers", containers ? hosts.length : undefined], ["Running", containers ? running : undefined], ["Unhealthy", containers ? unhealthy : undefined]].map(([label, count]) => <Card key={label}><CardContent className="pt-4"><div className="text-2xl font-semibold">{count ?? "—"}</div><div className="text-xs text-muted-foreground">{label}</div></CardContent></Card>)}</div>
    <Card><CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">Search<Input aria-label="Search containers" placeholder="Container, host or image…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label>
        <label className="min-w-44 space-y-1 text-xs text-muted-foreground">Host<Select aria-label="Container host" value={host} onChange={e => { setHost(e.target.value); setPage(1); }}><option value="">All hosts</option>{host && !hosts.includes(host) && <option value={host}>{host}</option>}{hosts.map(name => <option key={name}>{name}</option>)}</Select></label>
        <label className="min-w-36 space-y-1 text-xs text-muted-foreground">Status<Select aria-label="Container status" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["running", "stopped", "paused", "restarting", "unhealthy"].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</Select></label>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">Could not refresh containers: {error}{containers ? ". Showing previously loaded inventory." : ""}</p>}
      {!containers && !error && <p className="py-8 text-center text-muted-foreground">Loading all containers…</p>}
      {containers && <>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground">{["Container", "Host", "Image", "Status", "Health", "Restarts", "Last seen"].map(label => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>
          {rows.map(c => <tr key={`${c.hostname}/${c.id}`} className="border-b border-border hover:bg-accent/50">
            <td className="px-3 py-3 font-medium"><Link className="text-primary hover:underline" to={`/containers/${encodeURIComponent(c.hostname)}/${encodeURIComponent(c.name)}`}>{c.name}</Link></td>
            <td className="whitespace-nowrap px-3 py-3"><Link className="text-primary hover:underline" to={`/containers/${encodeURIComponent(c.hostname)}`}>{c.hostname}</Link></td>
            <td className="max-w-sm break-all px-3 py-3 font-mono text-xs">{c.image}</td>
            <td className="px-3 py-3"><Badge variant={STATUS_VARIANT[c.status] ?? "unknown"}>{c.status}</Badge></td>
            <td className="px-3 py-3">{c.health ? <Badge variant={c.health === "healthy" ? "ok" : c.health === "unhealthy" ? "critical" : c.health === "starting" ? "warning" : "unknown"}>{c.health}</Badge> : <span className="text-xs text-muted-foreground">Not reported</span>}</td>
            <td className="px-3 py-3">{c.restart_count}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground" title={new Date(c.last_seen).toLocaleString()}>{formatRelativeTime(c.last_seen)}</td>
          </tr>)}
          {!rows.length && <tr><td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">{containers.length ? "No containers match these filters." : "No containers have been discovered yet."}</td></tr>}
        </tbody></table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{filtered.length} of {containers.length} containers · Page {currentPage} of {pages}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</Button></div></div>
      </>}
      <p className="text-xs text-muted-foreground">Auto-refresh every 15 seconds{updated ? ` · Updated ${new Date(updated).toLocaleTimeString()}` : ""}. Last seen indicates when each container was last discovered on its host.</p>
    </CardContent></Card>
  </div>;
}
