import { useCallback } from "react";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, CircleHelp } from "lucide-react";

import { ContainerMonitoringTable, ContainerMonitoringCards } from "@/components/monitoring/ContainerMonitoringTable";
import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { MonitoringControls } from "@/components/monitoring/MonitoringControls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { atTime, duration, latest, containerValue, inventoryProblem, percent, problem, scopedUrl, useMonitoringData, useMonitoringQuery, type NativeHost } from "@/lib/monitoring";

export function hostDisk(host: NativeHost) {
  return [...(host.metrics.disk ?? [])].sort((a, b) => (latest([b]) ?? -1) - (latest([a]) ?? -1))[0];
}
export function HostStatus({host}: {host: NativeHost}) {
  const Icon = host.status === "Monitored" ? Activity : host.status === "Scrape failed" ? AlertTriangle : CircleHelp;
  return <Badge variant={host.status === "Monitored" ? "ok" : host.status === "Scrape failed" ? "warning" : "unknown"}><Icon className="mr-1 size-3"/>{host.status}</Badge>;
}
export function FleetMetricsGrid() {
  const {params, minutes, end, update} = useMonitoringQuery();
  const fetcher = useCallback(() => api.monitoring.fleet(minutes, end), [minutes, end]);
  const {data, error, loading, refresh} = useMonitoringData(fetcher, true, params.get("auto") !== "off" && end === undefined);
  const containersMode = params.get("fleet") === "containers";
  const q = (params.get("q") ?? "").toLowerCase();
  const hostFilter = params.get("host") ?? ""; const status = params.get("status") ?? "";
  const alerts = params.get("alerts") === "active"; const sort = params.get("sort") ?? "severity";
  const hosts = (data?.hosts ?? []).filter(h => (!hostFilter || h.id === hostFilter) &&
    (!q || containersMode || h.hostname.toLowerCase().includes(q) || h.ip_address.includes(q)) &&
    (!status || containersMode || h.status === status) && (!alerts || (h.alerts?.length ?? 0) > 0));
  const selected = new Set(hosts.map(h => h.id));
  const containers = (data?.containers ?? []).filter(c => selected.has(c.host_id) && (!containersMode ||
    ((!q || `${c.name} ${c.hostname} ${c.image}`.toLowerCase().includes(q)) && (!status || c.status === status) &&
    (!params.get("stack") || c.metadata.stack === params.get("stack")) &&
    (!params.get("health") || (c.health ?? "none") === params.get("health")))));
  const visibleHosts = containersMode ? hosts.filter(h => containers.some(c => c.host_id === h.id)) : hosts;
  const severity = (h: NativeHost) => (h.alerts ?? []).reduce((score, a) => score + (a.severity === "critical" ? 100 : 10), 0) + (h.status === "Monitored" ? 0 : 1);
  visibleHosts.sort((a, b) => sort === "name" ? a.hostname.localeCompare(b.hostname) : sort === "severity" ? severity(b) - severity(a) : (latest(b.metrics[sort]) ?? -1) - (latest(a.metrics[sort]) ?? -1));
  containers.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "severity" ? Number(problem(b)) - Number(problem(a)) : (containerValue(b,sort) ?? -1) - (containerValue(a,sort) ?? -1));
  const states = containersMode ? [...new Set(data?.containers.map(c => c.status))].sort() : ["Monitored", "Scrape failed", "Stale", "No data", "Not configured", "Source unavailable"];
  const containerCounts = [...new Set(containers.map(c => c.status))].map(s => `${containers.filter(c => c.status === s).length} ${s}`).join(" · ");
  return <Card><CardHeader><CardTitle>Fleet Metrics</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
    <MonitoringControls refresh={refresh} loading={loading}/>
    <Tabs value={containersMode ? "containers" : "hosts"} onValueChange={v => update({fleet:v, status:undefined})}>
      <TabsList aria-label="Fleet view"><TabsTrigger value="hosts">Hosts</TabsTrigger><TabsTrigger value="containers">Containers</TabsTrigger></TabsList>
    </Tabs>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 text-sm" aria-live="polite">
      <div className="rounded-md border border-border p-3"><strong>{visibleHosts.filter(h => h.monitoring_enabled).length}</strong> monitored hosts<div className="text-xs text-muted-foreground">{visibleHosts.filter(h => h.status === "Monitored").length} receiving data · {visibleHosts.filter(h => h.status !== "Monitored" || (h.alerts?.length ?? 0) > 0 || inventoryProblem(h)).length} need attention</div></div>
      <div className="rounded-md border border-border p-3"><strong>{data?.alerts_available ? visibleHosts.filter(h => (h.alerts?.length ?? 0) > 0).length : "—"}</strong> hosts with alerts<div className="text-xs text-muted-foreground">{data?.alerts_available ? "Active Alertmanager alerts" : "Alert source unavailable"}</div></div>
      <div className="rounded-md border border-border p-3"><strong>{containers.length}</strong> containers<div className="text-xs text-muted-foreground">{containerCounts || "No inventory matches"}</div></div>
      <div className="rounded-md border border-border p-3"><strong>{data ? Object.keys(data.errors).length + Object.keys(data.container_errors).length + (data.alerts_available ? 0 : 1) + visibleHosts.filter(inventoryProblem).length + visibleHosts.filter(h => h.status === "Stale" || h.status === "Scrape failed").length : "—"}</strong> collection issues<div className="text-xs text-muted-foreground">{visibleHosts.filter(h => h.status === "Stale" || h.status === "Scrape failed").length} stale / failed scrapes · {visibleHosts.filter(inventoryProblem).length} pending / stale inventories</div></div>
    </div>
    <div className="flex flex-wrap gap-2">
      <Input aria-label="Search hosts or containers" placeholder="Search hosts or containers…" value={params.get("q") ?? ""} onChange={e => update({q:e.target.value})} className="w-full sm:w-60"/>
      <Select aria-label="Filter host" value={hostFilter} onChange={e => update({host:e.target.value})} className="w-44"><option value="">All hosts</option>{data?.hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select>
      <Select aria-label="Filter status" value={status} onChange={e => update({status:e.target.value})} className="w-44"><option value="">All statuses</option>{states.map(s => <option key={s} value={s}>{s}</option>)}</Select>
      <Select aria-label="Filter alerts" value={params.get("alerts") ?? ""} onChange={e => update({alerts:e.target.value})} className="w-40"><option value="">All alerts</option><option value="active">Active alerts</option></Select>
      <Select aria-label="Sort" value={sort} onChange={e => update({sort:e.target.value})} className="w-40"><option value="severity">Severity</option><option value="name">Name</option><option value="cpu">CPU usage</option><option value="memory">Memory usage</option></Select>
      <Select aria-label="Layout" value={params.get(containersMode ? "container_view" : "view") ?? (containersMode ? "table" : "cards")} onChange={e => update({[containersMode ? "container_view" : "view"]:e.target.value})} className="w-36"><option value="cards">Cards</option><option value="table">Compact table</option></Select>
      {containersMode && <><Select aria-label="Filter stack" value={params.get("stack") ?? ""} onChange={e => update({stack:e.target.value})} className="w-44"><option value="">All stacks</option>{[...new Set(data?.containers.map(c => c.metadata.stack).filter(Boolean))].map(s => <option key={s} value={s!}>{s}</option>)}</Select>
        <Select aria-label="Filter healthcheck" value={params.get("health") ?? ""} onChange={e => update({health:e.target.value})} className="w-44"><option value="">All healthchecks</option>{["healthy","unhealthy","starting","none"].map(s => <option key={s} value={s}>{s === "none" ? "No healthcheck" : s}</option>)}</Select></>}
    </div>
    {loading && !data && <p className="text-muted-foreground">Loading inventory and metrics…</p>}
    {error && <p role="alert" className="text-status-warning">{error}</p>}
    {data && Object.keys(data.errors).length > 0 && <p className="text-sm text-status-warning">Some host metrics could not be collected. Device status is independent of these requests.</p>}
    {containersMode ? <><p className="text-xs text-muted-foreground">Inventory from configured Docker hosts. Resource values use Prometheus or labeled current Docker snapshots. Historical graphs require a mapped cAdvisor collector; — means no collected data. CPU may exceed 100%.</p>{params.get("container_view") === "cards" ? <ContainerMonitoringCards containers={containers} params={params}/> : <ContainerMonitoringTable containers={containers} params={params}/>}</> :
      params.get("view") === "table" ? <div className="overflow-x-auto"><table className="ops-card-table w-full text-left text-sm"><thead><tr>{["Host","Monitoring status","CPU","Memory","Disk / mount","Uptime","Containers","Alerts","Last measurement"].map(s => <th key={s} className="p-2 font-medium">{s}</th>)}</tr></thead><tbody>{visibleHosts.map(h => <tr key={h.id} className="border-t border-border hover:bg-accent/30"><td data-label="Host" className="p-2"><Link className="text-primary hover:underline" to={scopedUrl(`/monitoring/hosts/${h.id}`, params, {tab:"overview"})}>{h.hostname}</Link></td><td data-label="Monitoring status" className="p-2"><HostStatus host={h}/></td><td data-label="CPU" className="p-2">{percent(latest(h.metrics.cpu))}</td><td data-label="Memory" className="p-2">{percent(latest(h.metrics.memory))}</td><td data-label="Disk / mount" className="p-2">{percent(latest(hostDisk(h) ? [hostDisk(h)] : undefined))} {hostDisk(h)?.labels.mountpoint ?? ""}</td><td data-label="Uptime" className="p-2">{duration(latest(h.metrics.uptime))}</td><td data-label="Containers" className="p-2">{h.is_docker_host && h.container_inventory_at ? containers.filter(c => c.host_id === h.id).length : "Not collected"}</td><td data-label="Alerts" className="p-2">{h.alerts?.length ?? "Unknown"}</td><td data-label="Last measurement" className="p-2 text-xs">{atTime(h.last_sample)}</td></tr>)}</tbody></table></div> :
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleHosts.map(h => {
        const disk = hostDisk(h);
        return <Link key={h.id} to={scopedUrl(`/monitoring/hosts/${h.id}`, params, {tab:"overview"})} className="flex flex-col gap-3 rounded-md border border-border p-3 transition-colors hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong className="truncate text-sm">{h.hostname}</strong><HostStatus host={h}/></div>
          <div className="grid grid-cols-2 gap-2"><MetricSparkline label="CPU" points={h.metrics.cpu?.[0]?.points ?? []}/><MetricSparkline label="Memory" points={h.metrics.memory?.[0]?.points ?? []}/></div>
          <div className="flex flex-wrap justify-between gap-2 text-xs"><span>Disk {percent(latest(disk ? [disk] : undefined))} · {disk?.labels.mountpoint ?? "Not collected"}</span><span>Uptime {duration(latest(h.metrics.uptime))}</span></div>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{h.is_docker_host ? h.container_inventory_at ? `${containers.filter(c => c.host_id === h.id).length} containers` : "Inventory not collected" : "Containers not configured"}</span><span className={(h.alerts?.length ?? 0) > 0 ? "text-status-warning" : undefined}>{(h.alerts?.length ?? 0) > 0 ? "⚠ " : ""}{h.alerts?.length ?? "Unknown"} alerts</span><span>Last: {atTime(h.last_sample)}</span></div>
        </Link>;
      })}</div>}
    {data && !containersMode && visibleHosts.length === 0 && <p className="text-muted-foreground">No hosts match these filters.</p>}
  </CardContent></Card>;
}
