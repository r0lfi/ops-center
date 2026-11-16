import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatBytesPerSec } from "@/lib/format";
import type { NativeMetrics } from "@/lib/monitoring";

type Panel = {key: string; title: string; unit?: string; format?: (n:number) => string};
export const HOST_PANELS: Panel[] = [
  {key:"cpu",title:"CPU utilization"}, {key:"load1",title:"Load average · 1 minute",unit:""},
  {key:"load5",title:"Load average · 5 minutes",unit:""}, {key:"load15",title:"Load average · 15 minutes",unit:""},
  {key:"memory",title:"Memory utilization"}, {key:"memory_used",title:"Memory used",format:formatBytes},
  {key:"memory_total",title:"Memory total",format:formatBytes}, {key:"swap_used",title:"Swap used",format:formatBytes},
  {key:"swap_total",title:"Swap total",format:formatBytes}, {key:"disk",title:"Filesystem usage"},
  {key:"disk_bytes",title:"Filesystem used",format:formatBytes}, {key:"disk_total",title:"Filesystem size",format:formatBytes},
  {key:"inodes",title:"Inode usage"}, {key:"disk_read",title:"Disk read",format:formatBytesPerSec},
  {key:"disk_write",title:"Disk write",format:formatBytesPerSec}, {key:"network_rx",title:"Network receive",format:formatBytesPerSec},
  {key:"network_tx",title:"Network transmit",format:formatBytesPerSec},
];
export const CONTAINER_PANELS: Panel[] = [
  {key:"cpu",title:"CPU · 100% per core"}, {key:"memory",title:"Memory working set",format:formatBytes},
  {key:"network_rx",title:"Network receive",format:formatBytesPerSec}, {key:"network_tx",title:"Network transmit",format:formatBytesPerSec},
  {key:"disk_read",title:"Disk read",format:formatBytesPerSec}, {key:"disk_write",title:"Disk write",format:formatBytesPerSec},
];
export function MetricPanels({metrics, panels, errors = {}}: {metrics:NativeMetrics; panels:Panel[]; errors?:Record<string,string>}) {
  return <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{panels.map(p => <Card key={p.key}><CardHeader><CardTitle className="text-sm">{p.title}</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
    {!metrics[p.key]?.length ? <p className="min-h-28 text-sm text-muted-foreground">{errors[p.key] ?? "No collected data in this time range. The collector may not provide this metric."}</p> : metrics[p.key].map((s,i) => <MetricSparkline key={`${JSON.stringify(s.labels)}:${i}`} label={s.labels.mountpoint ?? s.labels.device ?? s.labels.interface ?? p.title} points={s.points} size="lg" unit={p.unit} format={p.format}/>)}
  </CardContent></Card>)}</div>;
}
