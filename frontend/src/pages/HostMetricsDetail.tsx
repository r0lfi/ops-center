import {
  Activity, ArrowDown, ArrowUp, Bell, Box, Database, ExternalLink, HardDrive,
  Network, Server, Waypoints,
} from "lucide-react";
import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { LogViewer } from "@/components/monitoring/LogViewer";
import { MonitoringControls } from "@/components/monitoring/MonitoringControls";
import { ContainerMonitoringTable } from "@/components/monitoring/ContainerMonitoringTable";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { isUnhealthy } from "@/lib/containers";
import { formatBytes, formatBytesPerSec, formatClock, formatDateTime } from "@/lib/format";
import {
  atTime, containerValue, duration, latest, problem, scopedUrl,
  useMonitoringData, useMonitoringQuery, totalLatest, RANGES, type NativeContainer, type NativeHost,
  type NativeSeries,
} from "@/lib/monitoring";

const TABS = ["overview", "metrics", "logs", "containers", "services", "alerts", "inventory"] as const;
const COLORS = ["#38bdf8", "#4ade80", "#fbbf24", "#fb7185", "#a78bfa", "#22d3ee"];
type Unit = "percent" | "bytes" | "rate" | "number";
function rangeLabel(minutes: number) { return RANGES.find(([value]) => value === minutes)?.[1] ?? String(minutes) + " min"; }
type ChartLine = { name: string; series: NativeSeries; color: string };
type MetricKey = "cpu" | "memory" | "load1" | "load5" | "load15" | "memory_used" |
  "memory_total" | "swap_used" | "swap_total" | "disk" | "disk_bytes" |
  "disk_total" | "inodes" | "disk_read" | "disk_write" | "network_rx" | "network_tx" | "uptime";

function chartLines(host: NativeHost, key: MetricKey, name: (s: NativeSeries) => string, offset = 0): ChartLine[] {
  return (host.metrics[key] ?? []).map((series, i) => ({
    name: name(series), series, color: COLORS[(i + offset) % COLORS.length],
  }));
}
function single(host: NativeHost, key: MetricKey, name: string, color: string): ChartLine[] {
  return chartLines(host, key, () => name).map(line => ({ ...line, color }));
}
function latestValue(host: NativeHost, key: MetricKey) { return latest(host.metrics[key]); }
function chartRows(lines: ChartLine[]) {
  const rows = new Map<number, Record<string, number>>();
  for (const line of lines) {
    for (const [ts, value] of line.series.points) {
      const row = rows.get(ts) ?? {};
      row[line.name] = value;
      rows.set(ts, row);
    }
  }
  return [...rows].sort(([a], [b]) => a - b).map(([ts, values]) => ({ ts, ...values }));
}
function formatValue(value: number, unit: Unit) {
  if (unit === "percent") return value.toFixed(0) + "%";
  if (unit === "bytes") return formatBytes(value);
  if (unit === "rate") return formatBytesPerSec(value);
  return value.toFixed(value < 10 ? 2 : 1);
}
function timeLabel(value: number) {
  return new Date(value * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function axisTime(value: number) {
  return formatClock(Number(value) * 1000);
}
function MetricChart({ title, lines, unit, range, error }: {
  title: string; lines: ChartLine[]; unit: Unit; range: string; error?: string;
}) {
  const rows = chartRows(lines);
  return <Card className="min-w-0 overflow-hidden border-border/80 bg-card/80">
    <CardHeader className="flex-row items-center justify-between gap-2 px-3 pb-1 pt-3">
      <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
      <span className="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{range}</span>
    </CardHeader>
    <CardContent className="px-2 pb-2 pt-0">
      {rows.length < 2 ? <div className="flex h-[142px] items-center justify-center text-xs text-muted-foreground">
        {error || (rows.length === 1 ? "Only one sample in this time range" : "No collected data for this metric")}
      </div> : <ResponsiveContainer width="100%" height={154}>
        <AreaChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="ts" tickFormatter={axisTime} minTickGap={36} axisLine={false} tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
          <YAxis width={50} tickFormatter={v => formatValue(Number(v), unit)} axisLine={false} tickLine={false}
            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
          <Tooltip labelFormatter={v => timeLabel(Number(v))}
            formatter={(v, name) => [formatValue(Number(v), unit), String(name)]}
            contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: "hsl(var(--foreground))", marginBottom: 4 }} />
          <Legend verticalAlign="bottom" height={22} iconType="circle" iconSize={6}
            wrapperStyle={{ fontSize: 10, color: "hsl(var(--muted-foreground))" }} />
          {lines.map((line, i) => <Area key={line.name + i} name={line.name} type="monotone"
            dataKey={line.name} stroke={line.color} fill={line.color} fillOpacity={lines.length === 1 ? 0.12 : 0.04}
            strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} connectNulls={false} />)}
        </AreaChart>
      </ResponsiveContainer>}
    </CardContent>
  </Card>;
}
function SummaryCard({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return <Card className="min-w-0 border-border/80 bg-card/80">
    <CardHeader className="flex-row items-center gap-2 px-3 pb-1 pt-3">
      <Icon className="size-3.5 text-muted-foreground" />
      <CardTitle className="text-[11px] font-semibold uppercase tracking-wide text-foreground">{title}</CardTitle>
    </CardHeader>
    <CardContent className="px-3 pb-3 pt-1">{children}</CardContent>
  </Card>;
}
function Gauge({ value, color }: { value: number | null; color: string }) {
  const radius = 19, circumference = 2 * Math.PI * radius;
  const safe = value === null ? 0 : Math.max(0, Math.min(value, 100));
  return <svg viewBox="0 0 52 52" className="size-14 shrink-0" role="img"
    aria-label={value === null ? "No percentage data" : value.toFixed(1) + " percent"}>
    <circle cx="26" cy="26" r={radius} fill="none" stroke="currentColor" className="text-secondary" strokeWidth="5" />
    {value !== null && <circle cx="26" cy="26" r={radius} fill="none" stroke={color} strokeWidth="5"
      strokeLinecap="round" strokeDasharray={String(circumference * safe / 100) + " " + String(circumference)}
      transform="rotate(-90 26 26)" />}
  </svg>;
}
function GaugeValue({ value, color, children }: { value: number | null; color: string; children?: ReactNode }) {
  return <div className="flex items-center gap-2.5"><Gauge value={value} color={color} />
    <div className="min-w-0"><div className="text-xl font-semibold tabular-nums">{value === null ? "—" : value.toFixed(0) + "%"}</div>{children}</div>
  </div>;
}
function NetworkMiniChart({ lines }: { lines: ChartLine[] }) {
  const rows = chartRows(lines);
  if (rows.length < 2) return <div className="flex h-8 items-center text-[10px] text-muted-foreground">No network samples</div>;
  return <ResponsiveContainer width="100%" height={34}><LineChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 1 }}>
    {lines.map((line, i) => <Line key={line.name + i} dataKey={line.name} type="monotone" stroke={line.color}
      strokeWidth={1.6} dot={false} isAnimationActive={false} />)}
  </LineChart></ResponsiveContainer>;
}
function HostOverview({ host, containers, params, minutes, errors }: {
  host: NativeHost; containers: NativeContainer[]; params: URLSearchParams;
  minutes: number; errors: Record<string, string>;
}) {
  const cpu = latestValue(host, "cpu"), memory = latestValue(host, "memory");
  const disks = [...(host.metrics.disk ?? [])].sort((a, b) => (b.points.at(-1)?.[1] ?? -1) - (a.points.at(-1)?.[1] ?? -1));
  const disk = disks[0], mount = disk?.labels.mountpoint ?? "/";
  const diskPercent = disk?.points.at(-1)?.[1] ?? null;
  const diskBytes = host.metrics.disk_bytes?.filter(s => s.labels.mountpoint === mount);
  const diskTotal = host.metrics.disk_total?.filter(s => s.labels.mountpoint === mount);
  const diskUsedBytes = latest(diskBytes);
  const diskSizeBytes = latest(diskTotal);
  const inode = host.metrics.inodes?.filter(s => s.labels.mountpoint === mount);
  const memoryUsed = latestValue(host, "memory_used"), memoryTotal = latestValue(host, "memory_total");
  const swapUsed = latestValue(host, "swap_used"), swapTotal = latestValue(host, "swap_total");
  const rx = totalLatest(host.metrics.network_rx), tx = totalLatest(host.metrics.network_tx);
  const running = containers.filter(c => c.status === "running").length;
  const stopped = containers.filter(c => ["exited", "created"].includes(c.status)).length;
  const unhealthy = containers.filter(isUnhealthy).length;
  const alerts = host.alerts;
  const critical = alerts?.filter(a => a.severity.toLowerCase() === "critical").length ?? null;
  const warning = alerts?.filter(a => a.severity.toLowerCase() === "warning").length ?? null;
  const otherAlerts = alerts?.filter(a => !["critical", "warning"].includes(a.severity.toLowerCase())).length ?? null;
  const range = rangeLabel(minutes);
  const inventoryStale = !!host.container_inventory_at && Date.now() - new Date(host.container_inventory_at).getTime() > 600000;
  const restarting = containers.filter(c => c.status === "restarting").length;
  const overviewCharts: [string, ChartLine[], Unit, string][] = [
    ["CPU Usage", single(host, "cpu", "CPU", COLORS[0]), "percent", "cpu"],
    ["Memory Usage", [
      ...single(host, "memory_used", "Used", COLORS[0]),
      ...single(host, "memory_total", "Total", COLORS[1]),
      ...single(host, "swap_used", "Swap", COLORS[3]),
    ], "bytes", "memory_used"],
    ["Disk Usage", chartLines(host, "disk", s => s.labels.mountpoint ?? "Filesystem"), "percent", "disk"],
    ["Network Traffic", [
      ...chartLines(host, "network_rx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " RX"),
      ...chartLines(host, "network_tx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " TX", 2),
    ], "rate", "network_rx"],
    ["Disk I/O", [
      ...chartLines(host, "disk_read", s => (s.labels.device ?? "Device") + " read"),
      ...chartLines(host, "disk_write", s => (s.labels.device ?? "Device") + " write", 2),
    ], "rate", "disk_read"],
    ["System Load", [
      ...single(host, "load1", "1m", COLORS[0]),
      ...single(host, "load5", "5m", COLORS[1]),
      ...single(host, "load15", "15m", COLORS[2]),
    ], "number", "load1"],
  ];
  return <>
    <section className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-6" aria-label="Host metrics at a glance">
      <SummaryCard title="CPU" icon={Activity}>
        <GaugeValue value={cpu} color={COLORS[0]}>
          <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
            {(["load1", "load5", "load15"] as const).map((key, i) =>
              <span key={key}>{latest(host.metrics[key])?.toFixed(2) ?? "—"} {["1m", "5m", "15m"][i]}</span>)}
          </div>
        </GaugeValue>
      </SummaryCard>
      <SummaryCard title="Memory" icon={Database}>
        <GaugeValue value={memory} color={COLORS[1]}>
          <div className="mt-1 text-[10px] text-muted-foreground">{memoryUsed === null ? "Used unavailable" : formatBytes(memoryUsed)} / {memoryTotal === null ? "Total unavailable" : formatBytes(memoryTotal)}</div>
          <div className="text-[10px] text-muted-foreground">Swap {swapUsed === null ? "—" : formatBytes(swapUsed)}{swapTotal && swapUsed !== null ? " (" + (swapUsed / swapTotal * 100).toFixed(0) + "%)" : ""}</div>
        </GaugeValue>
      </SummaryCard>
      <SummaryCard title={"Disk " + mount} icon={HardDrive}>
        <GaugeValue value={diskPercent} color={COLORS[2]}>
          <div className="mt-1 text-[10px] text-muted-foreground">{diskUsedBytes === null ? "Used unavailable" : formatBytes(diskUsedBytes)} / {diskSizeBytes === null ? "Total unavailable" : formatBytes(diskSizeBytes)}</div>
          <div className="text-[10px] text-muted-foreground">Inodes {inode?.length ? String(latest(inode)?.toFixed(0)) + "%" : "unavailable"}</div>
        </GaugeValue>
      </SummaryCard>
      <SummaryCard title="Network" icon={Network}>
        <div className="flex items-baseline justify-between gap-1 text-xs tabular-nums">
          <span className="truncate"><ArrowDown className="mr-1 inline size-3 text-sky-400" />{rx === null ? "—" : formatBytesPerSec(rx)}</span>
          <span className="truncate"><ArrowUp className="mr-1 inline size-3 text-emerald-400" />{tx === null ? "—" : formatBytesPerSec(tx)}</span>
        </div>
        <div className="mt-2"><NetworkMiniChart lines={[
          ...chartLines(host, "network_rx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " RX"),
          ...chartLines(host, "network_tx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " TX", 2),
        ]} /></div>
      </SummaryCard>
      <SummaryCard title="Containers" icon={Box}>
        {!host.is_docker_host ? <p className="text-xs text-muted-foreground">Not configured on this host</p> :
          !host.container_inventory_at ? <p className="text-xs text-muted-foreground">Inventory not collected</p> :
            <><div className="text-2xl font-semibold tabular-nums">{containers.length}</div>
              <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                <span className="text-emerald-400">{running} running</span><span>{stopped} stopped</span>
                <span className={unhealthy ? "text-rose-400" : ""}>{unhealthy} unhealthy</span>
                {restarting > 0 && <span className="text-amber-400">{restarting} restarting</span>}
                {inventoryStale && <span className="text-amber-400">Inventory stale</span>}
              </div></>}
      </SummaryCard>
      <SummaryCard title="Alerts" icon={Bell}>
        {alerts === null ? <p className="text-xs text-muted-foreground">Source unavailable</p> :
          <><div className="text-2xl font-semibold tabular-nums">{alerts.length}</div>
            <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
              <span className="text-rose-400">{critical} critical</span><span className="text-amber-400">{warning} warning</span>
              <span className="text-sky-400">{otherAlerts} other/unknown</span>
            </div></>}
      </SummaryCard>
    </section>
    <section className="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3" aria-label="Host metric history">
      {overviewCharts.map(([title, lines, unit, key]) =>
        <MetricChart key={title} title={title} lines={lines} unit={unit} range={range}
          error={lines.length ? undefined : errors[key]} />)}
    </section>
    <section className="grid min-w-0 grid-cols-1 gap-3 2xl:grid-cols-2">
      <ContainerPreview host={host} containers={containers} params={params} />
      <Card className="min-w-0 overflow-hidden border-border/80 bg-card/80">
        <CardHeader className="flex-row items-center justify-between px-3 pb-2 pt-3">
          <div><CardTitle className="font-semibold text-foreground">Recent Logs</CardTitle>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Host-filtered · selected time range</p></div>
        </CardHeader>
        <div className="px-3 pb-3"><LogViewer hostId={host.id} containers={containers} embedded compact /></div>
      </Card>
    </section>
  </>;
}
function ContainerPreview({ host, containers, params }: {
  host: NativeHost; containers: NativeContainer[]; params: URLSearchParams;
}) {
  const target = scopedUrl("/monitoring/hosts/" + host.id, params, { tab: "containers" });
  return <Card className="min-w-0 overflow-hidden border-border/80 bg-card/80">
    <CardHeader className="flex-row items-center justify-between px-3 pb-2 pt-3">
      <div><CardTitle className="font-semibold text-foreground">Containers ({containers.length})</CardTitle>
        <p className="mt-0.5 text-[10px] text-muted-foreground">Runtime status and current resource snapshot</p></div>
      <Link className="shrink-0 text-xs text-primary hover:underline" to={target}>View all →</Link>
    </CardHeader>
    {!host.is_docker_host ? <p className="px-3 pb-4 text-xs text-muted-foreground">Container collection is not configured for this host.</p> :
      !host.container_inventory_at ? <p className="px-3 pb-4 text-xs text-muted-foreground">Container inventory has not been collected yet.</p> :
        containers.length === 0 ? <p className="px-3 pb-4 text-xs text-muted-foreground">No containers in the current inventory.</p> :
          <div className="overflow-x-auto"><table className="ops-card-table w-full min-w-[520px] text-left text-[11px]">
            <thead className="border-y border-border bg-secondary/40 text-muted-foreground"><tr>
              {["Name", "Status", "Image", "CPU", "Memory", "Uptime"].map(name => <th key={name} className="px-3 py-2 font-medium">{name}</th>)}
            </tr></thead>
            <tbody>{containers.slice(0, 8).map(c => {
              const started = c.metadata.started_at && !c.metadata.started_at.startsWith("0001") ? new Date(c.metadata.started_at).getTime() : NaN;
              const uptime = c.status !== "running" ? "—" : Number.isFinite(started) ? duration((Date.now() - started) / 1000) : "Unknown";
              const cpu = containerValue(c, "cpu"), memory = containerValue(c, "memory");
              return <tr key={c.id} className="border-b border-border/70 last:border-0 hover:bg-accent/40">
                <td data-label="Name" className="max-w-[140px] truncate px-3 py-2"><Link className="font-medium text-primary hover:underline" to={scopedUrl("/monitoring/containers/" + c.id, params, { tab: "overview" })}>{c.name}</Link></td>
                <td data-label="Status" className="whitespace-nowrap px-3 py-2"><span className={problem(c) ? "text-rose-400" : c.status === "running" ? "text-emerald-400" : "text-muted-foreground"}>● {c.status}</span>
                  <div className="text-[9px] text-muted-foreground">{c.health ?? "No healthcheck"}</div></td>
                <td data-label="Image" className="max-w-[145px] truncate px-3 py-2 font-mono text-[10px] text-muted-foreground" title={c.image}>{c.image}</td>
                <td data-label="CPU" className="whitespace-nowrap px-3 py-2 tabular-nums">{cpu === null ? "—" : cpu.toFixed(1) + "%"}</td>
                <td data-label="Memory" className="whitespace-nowrap px-3 py-2 tabular-nums">{memory === null ? "—" : formatBytes(memory)}</td>
                <td data-label="Uptime" className="whitespace-nowrap px-3 py-2 text-muted-foreground">{uptime}</td>
              </tr>;
            })}</tbody>
          </table></div>}
  </Card>;
}

export default function HostMetricsDetail() {
  const { hostId, hostname } = useParams<{ hostId: string; hostname: string }>();
  const { params, minutes, end, update } = useMonitoringQuery();
  const requestedTab = params.get("tab") ?? "overview";
  const tab = (TABS as readonly string[]).includes(requestedTab) ? requestedTab : "overview";
  const fetcher = useCallback(async () => {
    let id = hostId;
    if (!id) {
      const matches = (await api.hosts.list()).filter(host => host.hostname === hostname);
      if (matches.length !== 1) throw new Error("Host identity is missing or ambiguous. Open the host from Monitoring.");
      id = matches[0].id;
    }
    return api.monitoring.fleet(minutes, end, id);
  }, [hostId, hostname, minutes, end]);
  const { data, error, loading, refresh } = useMonitoringData(fetcher, true,
    params.get("auto") !== "off" && end === undefined && tab !== "logs");
  const host = data?.hosts.find(item => hostId ? item.id === hostId : item.hostname === hostname);
  const containers = data?.containers.filter(container => container.host_id === hostId || container.hostname === hostname) ?? [];
  const kernel = host?.metrics.uname?.[0]?.labels.release;
  const grafanaUrl = host ? "/grafana/d/ops-linux-host-overview/linux-host-overview?" + new URLSearchParams({
    "var-instance": host.hostname,
    from: String(Math.floor(((end ?? Date.now() / 1000) - minutes * 60) * 1000)),
    to: String(Math.floor((end ?? Date.now() / 1000) * 1000)),
  }) : "#";
  const logsUrl = host ? scopedUrl("/logs", params, {
    host: undefined, host_id: host.id, container_id: undefined, end: end ? String(end) : undefined,
  }) : "/logs";

  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-2">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link to="/monitoring" className="hover:text-foreground">Ops Center</Link><span>›</span>
        <Link to="/monitoring" className="hover:text-foreground">Monitoring</Link><span>›</span>
        <span className="font-medium text-foreground">{host?.hostname ?? hostname ?? "Host"}</span>
      </nav>
      <MonitoringControls refresh={refresh} loading={loading} />
    </div>
    <header className="flex flex-wrap items-start justify-between gap-4 py-1">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-1 flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Server className="size-5" /></div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{host?.hostname ?? hostname ?? "Host details"}</h1>
            {host && <Badge variant={host.status === "Monitored" ? "ok" : host.status === "Scrape failed" ? "critical" : host.status === "Stale" || host.status === "Source unavailable" ? "warning" : "unknown"}>
              <span className={"mr-1.5 inline-block size-2 rounded-full " + (host.status === "Monitored" ? "bg-status-ok" : host.status === "Scrape failed" ? "bg-status-critical" : host.status === "Stale" || host.status === "Source unavailable" ? "bg-status-warning" : "bg-status-unknown")} />
              {host.status === "Monitored" ? "Online" : host.status}
            </Badge>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {host?.ip_address && <span className="font-mono"><Network className="mr-1 inline size-3" />{host.ip_address}</span>}
            <span><Database className="mr-1 inline size-3" />{host?.operating_system ?? "OS not collected"} {host?.os_version}</span>
            <span className="font-mono"><Activity className="mr-1 inline size-3" />{kernel ?? "Kernel not collected"}</span>
            <span><Waypoints className="mr-1 inline size-3" />Uptime: {host ? duration(latestValue(host, "uptime")) : "Not available"}</span>
            <span>Last metrics: {host ? atTime(host.last_sample) : "No data"}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={grafanaUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs hover:border-primary"><ExternalLink className="size-3.5" />Open in Grafana</a>
        <Link to={logsUrl} className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 text-xs hover:border-primary"><ExternalLink className="size-3.5" />Open in Logs</Link>
        {host && <details className="relative">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-md border border-border px-3 text-xs hover:border-primary">More</summary>
          <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-card p-1 shadow-xl">
            <Link className="block rounded px-3 py-2 text-xs hover:bg-accent" to={"/servers/" + host.id}>Open host inventory</Link>
          </div>
        </details>}
      </div>
    </header>
    {error && <p role="alert" className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3 text-sm text-status-warning">{error}</p>}
    {!host && !error && <p className="text-muted-foreground">Loading host details…</p>}
    {host && <>
      {Object.keys(data?.errors ?? {}).length > 0 && <p className="rounded-md border border-status-warning/30 bg-status-warning/5 p-2 text-xs text-status-warning">
        Some metrics could not be collected: {Object.keys(data?.errors ?? {}).join(", ")}. Other sources remain available.</p>}
      <Tabs value={tab} onValueChange={key => update({ tab: key })}>
        <TabsList aria-label="Host details" className="gap-1 overflow-x-auto">
          {TABS.map(key => <TabsTrigger key={key} value={key}>{key[0].toUpperCase() + key.slice(1)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-3">
          <HostOverview host={host} containers={containers} params={params} minutes={minutes} errors={data?.errors ?? {}} />
        </TabsContent>
        <TabsContent value="metrics"><div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          <MetricChart title="CPU Usage" lines={single(host, "cpu", "CPU", COLORS[0])} unit="percent" range={rangeLabel(minutes)} error={data?.errors.cpu} />
          <MetricChart title="System Load" lines={[
            ...single(host, "load1", "1m", COLORS[0]), ...single(host, "load5", "5m", COLORS[1]),
            ...single(host, "load15", "15m", COLORS[2]),
          ]} unit="number" range={rangeLabel(minutes)} error={data?.errors.load1} />
          <MetricChart title="Memory & Swap" lines={[
            ...single(host, "memory_used", "Used", COLORS[0]), ...single(host, "memory_total", "Total", COLORS[1]),
            ...single(host, "swap_used", "Swap used", COLORS[2]), ...single(host, "swap_total", "Swap total", COLORS[3]),
          ]} unit="bytes" range={rangeLabel(minutes)} error={data?.errors.memory_used} />
          <MetricChart title="Filesystem Space" lines={[
            ...chartLines(host, "disk_bytes", s => (s.labels.mountpoint ?? "Filesystem") + " used"),
            ...chartLines(host, "disk_total", s => (s.labels.mountpoint ?? "Filesystem") + " total", 1),
          ]} unit="bytes" range={rangeLabel(minutes)} error={data?.errors.disk_bytes} />
          <MetricChart title="Filesystem Usage" lines={chartLines(host, "disk", s => s.labels.mountpoint ?? "Filesystem")} unit="percent" range={rangeLabel(minutes)} error={data?.errors.disk} />
          <MetricChart title="Inode Usage" lines={chartLines(host, "inodes", s => (s.labels.mountpoint ?? "Filesystem") + " inodes")} unit="percent" range={rangeLabel(minutes)} error={data?.errors.inodes} />
          <MetricChart title="Disk I/O" lines={[
            ...chartLines(host, "disk_read", s => (s.labels.device ?? "Device") + " read"),
            ...chartLines(host, "disk_write", s => (s.labels.device ?? "Device") + " write", 2),
          ]} unit="rate" range={rangeLabel(minutes)} error={data?.errors.disk_read} />
          <MetricChart title="Network Traffic" lines={[
            ...chartLines(host, "network_rx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " RX"),
            ...chartLines(host, "network_tx", s => (s.labels.device ?? s.labels.interface ?? "Interface") + " TX", 2),
          ]} unit="rate" range={rangeLabel(minutes)} error={data?.errors.network_rx} />
        </div><p className="mt-3 text-xs text-muted-foreground">Charts contain real Prometheus samples only. If a series is absent, its collector does not currently provide it.</p></TabsContent>
        <TabsContent value="logs">{tab === "logs" && <LogViewer hostId={host.id} containers={containers} />}</TabsContent>
        <TabsContent value="containers">
          {!host.is_docker_host ? <p className="py-6 text-sm text-muted-foreground">Container collection is not configured for this host.</p> :
            !host.container_inventory_at ? <p className="py-6 text-sm text-muted-foreground">Container inventory has not been collected yet.</p> :
              <div className="flex flex-col gap-3"><p className="text-xs text-muted-foreground">Inventory received {formatDateTime(host.container_inventory_at)}. Runtime and health states are separate. Current Docker snapshots are not historical measurements.</p>
                <ContainerMonitoringTable containers={containers} params={params} /></div>}
        </TabsContent>
        <TabsContent value="services"><div className="flex flex-col gap-2">
          {!host.services.length && <p className="text-sm text-muted-foreground">No service checks are configured for this host.</p>}
          {host.services.map(check => {
            const status = latest(host.metrics.services?.filter(s => s.labels.unit === check.target));
            const sample = latest(host.metrics.service_sample?.filter(s => s.labels.unit === check.target));
            const stale = sample !== null && (end ?? Date.now() / 1000) - sample > 300;
            return <Card key={check.id} className="border-border/80 bg-card/80"><CardContent className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
              <div><strong className="font-mono text-xs">{check.target}</strong><p className="text-xs text-muted-foreground">
                {!check.enabled ? "Disabled" : check.check_type !== "systemd_unit" ? "Status not supplied by this source" :
                  stale ? "Stale" : status === null ? "No collected status" : status === 1 ? "Active" : "Inactive"} · {atTime(sample)}</p></div>
              {check.check_type === "systemd_unit" && host.log_collection_enabled &&
                <Link className="text-xs text-primary hover:underline" to={scopedUrl("/logs", params, {
                  host: undefined, host_id: host.id, service: check.target, container_id: undefined,
                })}>Open service logs →</Link>}
            </CardContent></Card>;
          })}
          <Link className="text-xs text-primary hover:underline" to="/services">Open Services →</Link>
        </div></TabsContent>
        <TabsContent value="alerts">
          {host.alerts === null ? <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">Alertmanager is unavailable.</p> :
            <div className="flex flex-col gap-2">{!host.alerts.length && <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">No active alerts for this host.</p>}
              {host.alerts.map((alert, i) => <Link key={alert.name + i} to={scopedUrl("/alerts", params, {
                host: host.hostname, alert: alert.name,
              })} className="rounded-md border border-border bg-card/80 p-3 hover:border-primary">
                <div className="flex items-center justify-between gap-3"><Badge variant={alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "warning" : "secondary"}>{alert.severity}</Badge>
                  <span className="text-[10px] text-muted-foreground">{alert.starts_at ? timeLabel(new Date(alert.starts_at).getTime() / 1000) : "Start time unavailable"}</span></div>
                <p className="mt-2 text-sm font-medium">{alert.name}</p><p className="text-xs text-muted-foreground">{alert.summary || "No summary supplied by Alertmanager"}</p>
              </Link>)}
              <Link className="text-xs text-primary hover:underline" to={scopedUrl("/alerts", params, { host: host.hostname })}>Open Alerts →</Link>
            </div>}
        </TabsContent>
        <TabsContent value="inventory">
          <Card className="border-border/80 bg-card/80"><CardContent className="grid grid-cols-1 gap-3 px-3 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <InventoryField label="Inventory host ID" value={host.id} mono />
            <InventoryField label="Address" value={host.ip_address || "Not collected"} mono />
            <InventoryField label="Operating system" value={(host.operating_system ?? "Not collected") + " " + (host.os_version ?? "")} />
            <InventoryField label="Kernel" value={kernel ?? "Not collected"} mono />
            <InventoryField label="Monitoring" value={host.monitoring_enabled ? host.status : "Not configured"} />
            <InventoryField label="Host log collection" value={host.log_collection_enabled ? "Configured" : "Not configured"} />
            <InventoryField label="Container inventory" value={!host.is_docker_host ? "Not configured" :
              host.container_inventory_at ? atTime(new Date(host.container_inventory_at).getTime() / 1000) : "Not collected"} />
            <InventoryField label="Last Prometheus sample" value={atTime(host.last_sample)} />
            <div className="flex items-end"><Link className="text-primary hover:underline" to={"/servers/" + host.id}>Open full host inventory →</Link></div>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </>}
  </div>;
}
function InventoryField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={"mt-1 break-words " + (mono ? "font-mono" : "")}>{value}</div></div>;
}
