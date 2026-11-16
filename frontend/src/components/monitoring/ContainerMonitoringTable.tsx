import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { formatBytes, formatBytesPerSec, formatDateTime } from "@/lib/format";
import { atTime, latest, percent, containerValue, problem, scopedUrl, stale, totalLatest, type NativeContainer } from "@/lib/monitoring";

export function ContainerMonitoringTable({containers, params}: {containers: NativeContainer[]; params: URLSearchParams}) {
  return <div className="overflow-x-auto rounded-md border border-border"><table className="ops-card-table w-full text-left text-sm">
    <thead className="border-b border-border text-xs text-muted-foreground"><tr>
      {["Container", "Host", "Image / stack", "Runtime / health", "CPU", "Memory / limit", "Network RX / TX", "Restarts", "Started", "Inventory updated"].map(title => <th key={title} className="whitespace-nowrap p-3 font-medium">{title}</th>)}
    </tr></thead><tbody>
    {!containers.length && <tr><td colSpan={10} className="p-6 text-muted-foreground">No containers match these filters.</td></tr>}
    {containers.map(c => {
      const snapshot = c.metadata.runtime_stats;
      const memory = containerValue(c,"memory");
      const memLimit = c.metadata.memory_limit;
      const rx = totalLatest(c.metrics.network_rx); const tx = totalLatest(c.metrics.network_tx);
      return <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/30">
        <td data-label="Container" className="p-3"><Link className="font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-primary" to={scopedUrl(`/monitoring/containers/${c.id}`, params, {tab: "overview"})}>{c.name}</Link></td>
        <td data-label="Host" className="p-3"><Link className="text-primary hover:underline" to={scopedUrl(`/monitoring/hosts/${c.host_id}`, params, {tab: "containers"})}>{c.hostname}</Link></td>
        <td data-label="Image / stack" className="max-w-56 p-3"><div className="truncate font-mono text-xs" title={c.image}>{c.image}</div><div className="text-xs text-muted-foreground">{c.metadata.stack ?? "No stack label"}</div></td>
        <td data-label="Runtime / health" className="whitespace-nowrap p-3"><Badge variant={stale(c) ? "unknown" : problem(c) ? "warning" : "unknown"}>{c.status}</Badge><div className="mt-1 text-xs text-muted-foreground">{c.health ?? "No healthcheck"}{stale(c) ? " · Inventory stale" : ""}</div></td>
        <td data-label="CPU" className="whitespace-nowrap p-3 tabular-nums">{percent(containerValue(c,"cpu"))}{(!c.metrics.cpu?.length || c.metrics_state === "Stale") && snapshot && <div className="text-xs text-muted-foreground">Runtime snapshot</div>}</td>
        <td data-label="Memory / limit" className="whitespace-nowrap p-3 tabular-nums">{memory === null ? "—" : formatBytes(memory)}<div className="text-xs text-muted-foreground">{memLimit === undefined ? "Not collected" : memLimit ? formatBytes(memLimit) : "Not configured"}</div></td>
        <td data-label="Network RX / TX" className="whitespace-nowrap p-3 text-xs">{rx === null && tx === null && snapshot?.network_io ? <>{snapshot.network_io}<div className="text-muted-foreground">Cumulative bytes</div></> : <>{rx === null ? "—" : formatBytesPerSec(rx)} / {tx === null ? "—" : formatBytesPerSec(tx)}</>}</td>
        <td data-label="Restarts" className="p-3 tabular-nums">{c.restart_count ?? "—"}</td>
        <td data-label="Started" className="whitespace-nowrap p-3 text-xs">{c.metadata.started_at && !c.metadata.started_at.startsWith("0001") ? formatDateTime(c.metadata.started_at) : "Not available"}</td>
        <td data-label="Inventory updated" className="whitespace-nowrap p-3 text-xs">{c.last_seen ? formatDateTime(c.last_seen) : "No inventory data"}<div className="text-muted-foreground">{snapshot && !c.metrics.last_sample?.length ? `Snapshot: ${formatDateTime(snapshot.captured_at)}` : `Metrics: ${atTime(latest(c.metrics.last_sample))}`}</div></td>
      </tr>;
    })}</tbody></table></div>;
}

export function ContainerMonitoringCards({containers, params}: {containers:NativeContainer[];params:URLSearchParams}) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{containers.map(c => <Link key={c.id} className="flex flex-col gap-2 rounded-md border border-border p-3 transition-colors hover:border-primary focus-visible:outline focus-visible:outline-primary" to={scopedUrl(`/monitoring/containers/${c.id}`,params,{tab:"overview"})}>
    <strong className="text-sm">{c.name}</strong><span className="text-xs text-muted-foreground">{c.hostname} · {c.metadata.stack ?? "No stack"}</span>
    <div className="flex flex-wrap gap-2 text-xs"><Badge variant={problem(c)?"warning":"unknown"}>{c.status}</Badge><span>{c.health ?? "No healthcheck"}</span>{stale(c) && <span>Inventory stale</span>}</div>
    <span className="truncate font-mono text-xs" title={c.image}>{c.image}</span>
    <div className="text-sm">CPU {percent(containerValue(c,"cpu"))} · Memory {containerValue(c,"memory") === null ? "—" : formatBytes(containerValue(c,"memory")!)}</div>
    <span className="text-xs text-muted-foreground">Memory limit: {c.metadata.memory_limit ? formatBytes(c.metadata.memory_limit) : "Not configured"}</span>
  </Link>)}</div>;
}
