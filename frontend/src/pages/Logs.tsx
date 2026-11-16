import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { LogViewer } from "@/components/monitoring/LogViewer";
import { Select } from "@/components/ui/select";
import { api, type Host } from "@/lib/api";
import { useMonitoringQuery } from "@/lib/monitoring";

export default function Logs() {
  const {params, update} = useMonitoringQuery();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; api.hosts.list().then(h => {if (active) setHosts(h);}).catch(e => {if (active) setError(e.message);}); return () => {active = false;}; }, []);
  const selected = params.get("host_id") ?? hosts.find(h => h.hostname === params.get("host"))?.id ?? "";
  return <div className="flex flex-col gap-4"><PageHeader title="Logs" description={<>Inventory-scoped journal, syslog and auth logs from Loki. Container views use the existing Docker log driver on the selected host.</>} />
    {error && <p role="alert" className="text-status-warning">{error}</p>}
    <Select aria-label="Log host" value={selected} onChange={e => update({host_id:e.target.value,host:undefined,container_id:undefined,log_container:undefined})} className="w-60"><option value="">All authorized hosts</option>{hosts.map(h => <option key={h.id} value={h.id}>{h.hostname}</option>)}</Select>
    <LogViewer embedded={false}/>
  </div>;
}
