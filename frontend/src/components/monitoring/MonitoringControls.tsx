import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { RANGES, useMonitoringQuery } from "@/lib/monitoring";
import { formatDateTime } from "@/lib/format";

export function MonitoringControls({refresh, loading}: {refresh: () => void; loading: boolean}) {
  const {params, minutes, end, update} = useMonitoringQuery();
  return <div className="flex flex-wrap items-center gap-3 text-sm">
    <Select aria-label="Time range" value={minutes} onChange={e => update({minutes: e.target.value})} className="w-32">
      {RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select>
    <label className="flex items-center gap-2"><input type="checkbox" checked={end === undefined}
      onChange={e => update({end: e.target.checked ? undefined : String(Date.now() / 1000)})}/>Live window</label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={params.get("auto") !== "off"}
      onChange={e => update({auto: e.target.checked ? undefined : "off"})}/>Auto refresh</label>
    <Button variant="outline" size="sm" onClick={refresh} disabled={loading}><RefreshCw className="mr-1 size-4"/>Refresh</Button>
    <span className="text-xs text-muted-foreground">{end ? `Historical · ending ${formatDateTime(end * 1000)}` : params.get("auto") === "off" ? "Rolling window · manual refresh" : "Rolling window · 30s refresh"}</span>
  </div>;
}
