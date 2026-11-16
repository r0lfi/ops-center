import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";

import { LogViewer } from "@/components/monitoring/LogViewer";
import { CONTAINER_PANELS, MetricPanels } from "@/components/monitoring/MetricPanels";
import { MonitoringControls } from "@/components/monitoring/MonitoringControls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { latest, percent, problem, scopedUrl, stale, useMonitoringData, useMonitoringQuery } from "@/lib/monitoring";

const TABS = ["overview","metrics","logs","events"];
function Row({label, value}: {label:string;value:string}) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all text-sm">{value}</dd></div>; }
export default function ContainerMonitoringDetail() {
  const {containerId = ""} = useParams();
  const {params, minutes, end, update} = useMonitoringQuery();
  const tab = TABS.includes(params.get("tab") ?? "") ? params.get("tab")! : "overview";
  const fetcher = useCallback(() => api.monitoring.container(containerId, minutes, end), [containerId, minutes, end]);
  const {data, error, loading, refresh} = useMonitoringData(fetcher, true, params.get("auto") !== "off" && end === undefined && tab !== "logs");
  const c = data?.id === containerId ? data : null;
  const eventFetcher = useCallback(() => api.monitoring.events(containerId, minutes, end), [containerId, minutes, end]);
  const events = useMonitoringData(eventFetcher, tab === "events", false);
  const statFetcher = useCallback(() => api.monitoring.stats(containerId), [containerId]);
  const stats = useMonitoringData(statFetcher, tab === "overview" && !!c?.runtime_id && end === undefined, false);
  const limit = c?.metadata.memory_limit; const memory = latest(c?.metrics.memory);
  const memoryPct = memory !== null && limit ? memory / limit * 100 : null; const m = c?.metadata;
  return <div className="flex flex-col gap-4">
    <Link className="flex items-center gap-2 text-primary" to={scopedUrl("/monitoring",params,{tab:undefined,fleet:"containers",host_id:undefined,container_id:undefined,log_container:undefined})}><ArrowLeft className="size-4"/>Monitoring / Containers</Link>
    <h1 className="break-words text-2xl font-semibold">{c?.name ?? "Container details"}</h1>
    {error && <p role="alert" className="text-status-warning">{error}</p>}
    {!c && !error && <p className="text-muted-foreground">Loading container details…</p>}
    <MonitoringControls refresh={() => {refresh(); if (tab === "events") events.refresh(); if (tab === "overview") stats.refresh();}} loading={loading}/>
    {c && <>
      <div className="flex flex-wrap items-center gap-3 text-sm"><Badge variant={problem(c) ? "warning" : "unknown"}>{c.status}</Badge><span>Healthcheck: {c.health ?? "Not configured"}</span>{stale(c) && <span className="text-status-warning">Inventory stale</span>}
        <Link className="text-primary hover:underline" to={scopedUrl(`/monitoring/hosts/${c.host_id}`,params,{tab:"containers",container_id:undefined,log_container:undefined})}>{c.hostname}</Link>
        <Link className="text-primary hover:underline" to={`/containers/${encodeURIComponent(c.hostname)}/${encodeURIComponent(c.name)}`}>Open container administration</Link>
      </div>
      <p className="break-all font-mono text-xs text-muted-foreground">Runtime ID: {c.runtime_id ?? "Not collected yet"} · Inventory updated: {c.last_seen ? formatDateTime(c.last_seen) : "Not available"}</p>
      <Tabs value={tab} onValueChange={value => update({tab:value})}><TabsList aria-label="Container details">{TABS.map(value => <TabsTrigger key={value} value={value}>{value.charAt(0).toUpperCase()+value.slice(1)}</TabsTrigger>)}</TabsList>
        <TabsContent value="overview" className="flex flex-col gap-4"><Card><CardContent className="py-4"><dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Image" value={c.image}/><Row label="Stack" value={m?.stack ?? "Not configured"}/><Row label="Started" value={m?.started_at && !m.started_at.startsWith("0001") ? formatDateTime(m.started_at) : "Not available"}/>
          <Row label="Restart count" value={c.restart_count === null ? "Not collected" : String(c.restart_count)}/><Row label="Exit code" value={m?.exit_code == null ? "Not collected" : String(m.exit_code)}/>
          <Row label="Memory limit" value={limit === undefined ? "Not collected" : limit ? formatBytes(limit) : "Not configured"}/><Row label="CPU limit" value={m?.nano_cpus ? `${m.nano_cpus / 1e9} cores` : m?.cpu_quota && m.cpu_period ? `${m.cpu_quota / m.cpu_period} cores` : "Not configured"}/>
          <Row label="Memory working set / limit" value={memory === null ? "No historical memory data" : `${formatBytes(memory)} · ${memoryPct === null ? "Not configured" : percent(memoryPct)}`}/>
          <Row label="Networks" value={m?.networks === undefined ? "Not collected" : m.networks.join(", ") || "No attached networks"}/>
        </dl></CardContent></Card>
        <Card><CardContent className="flex flex-col gap-3 py-4 text-sm"><strong>Current Docker snapshot</strong>
          {end !== undefined ? <p className="text-muted-foreground">Current runtime stats are omitted for a historical time window.</p> : stats.error ? <p className="text-status-warning">{stats.error}</p> : stats.loading ? <p>Loading current stats…</p> : stats.data && [stats.data.CPUPerc,stats.data.MemUsage,stats.data.NetIO,stats.data.BlockIO].some(Boolean) ? <div className="flex flex-wrap gap-4"><span>CPU {stats.data.CPUPerc ?? "Not available"}</span><span>Memory {stats.data.MemUsage ?? "Not available"}</span><span>Network {stats.data.NetIO ?? "Not available"}</span><span>Block I/O {stats.data.BlockIO ?? "Not available"}</span><span>Measured {stats.data.measured_at ? formatDateTime(stats.data.measured_at) : "now"}. Docker CLI memory denominator may be host memory when no limit is configured.</span></div> : <p className="text-muted-foreground">Runtime stats are not available for this container.</p>}
        </CardContent></Card>
        <Card><CardContent className="flex flex-col gap-3 py-4 text-sm"><strong>Ports</strong>{Object.entries(m?.ports ?? {}).length ? Object.entries(m?.ports ?? {}).map(([port,bindings]) => <div key={port}>{port}: {bindings?.map(b => `${b.HostIp}:${b.HostPort}`).join(", ") || "Not published"}</div>) : <p className="text-muted-foreground">{m?.ports === undefined ? "Port inventory has not been collected yet." : "No published ports in collected inventory."}</p>}
          <strong>Mounts</strong>{m?.mounts?.length ? m.mounts.map((mount,i) => <div key={i} className="break-all font-mono text-xs">{mount.Type} · {mount.Source} → {mount.Destination} · {mount.RW ? "read-write" : "read-only"}</div>) : <p className="text-muted-foreground">{m?.mounts === undefined ? "Mount inventory has not been collected yet." : "No mounts in collected inventory."}</p>}
        </CardContent></Card>
        </TabsContent>
        <TabsContent value="metrics" className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">Historical data from cAdvisor through Prometheus, matched by host and full runtime ID. CPU is rate of CPU seconds × 100: one fully used core is 100%; multiple cores may exceed 100%. Memory is working set; memory percentage uses the configured Docker memory limit. Without a limit, percentage is not configured.</p>
          {c.metrics_state && <p className="text-sm">Historical metrics: {c.metrics_state}. {c.metrics_state === "Not configured" ? "The collector has no confirmed inventory-host mapping. Configure a host_id target label or the backend target mapping." : c.metrics_state === "No data" ? "No matching runtime-ID samples exist in this time range. The collector may not expose Docker runtime IDs or may have insufficient retention." : c.metrics_state === "Stale" ? "The last actual sample is older than the collection freshness window." : ""}</p>}
          <p className="text-sm">Memory / configured limit: {memoryPct === null ? "Not configured or no collected data" : percent(memoryPct)}</p>
          <MetricPanels metrics={c.metrics} panels={CONTAINER_PANELS} errors={c.errors}/>
        </TabsContent>
        <TabsContent value="logs">{tab === "logs" && <LogViewer hostId={c.host_id} containerId={c.id}/>}</TabsContent>
        <TabsContent value="events"><div className="flex flex-col gap-3"><p className="text-xs text-muted-foreground">Actual Docker events for this runtime ID and selected time range. Docker daemon history may retain only a limited window.</p>
          {events.error && <p role="alert" className="text-status-warning">{events.error}</p>}{events.loading && <p>Loading events…</p>}
          {events.data?.state === "not_configured" && <p>Event identity has not been collected.</p>}
          {events.data?.state === "available" && !events.data.events.length && <p className="text-muted-foreground">No retained events for this container in the selected range.</p>}
          {events.data?.events.map((event,i) => <div key={i} className="rounded-md border border-border p-3 text-sm">{formatDateTime(event.occurred_at)} · {event.action}</div>)}
        </div></TabsContent>
      </Tabs>
    </>}
  </div>;
}
