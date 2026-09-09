import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api, type Host, type HostMetricsResponse } from "@/lib/api";
import { formatBytesPerSec } from "@/lib/format";

const LIVE_POLL_MS = 5000;

export default function HostMetricsDetail() {
  const { hostname } = useParams<{ hostname: string }>();
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [metrics, setMetrics] = useState<HostMetricsResponse | null>(null);

  useEffect(() => {
    api.hosts.list().then(setHosts).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!hostname) return;
    let cancelled = false;

    async function poll() {
      try {
        const result = await api.metrics.hosts(60, hostname);
        if (!cancelled) setMetrics(result);
      } catch {
        // ignore - transient
      }
    }

    setMetrics(null);
    poll();
    const interval = setInterval(poll, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hostname]);

  const cpu = metrics?.cpu.find((s) => s.instance === hostname)?.points ?? [];
  const memory = metrics?.memory.find((s) => s.instance === hostname)?.points ?? [];
  const disk = metrics?.disk.find((s) => s.instance === hostname)?.points ?? [];
  const rx = metrics?.network_rx.find((s) => s.instance === hostname)?.points ?? [];
  const tx = metrics?.network_tx.find((s) => s.instance === hostname)?.points ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/monitoring" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-semibold">{hostname}</h1>
          <span className="flex items-center gap-1.5 text-xs text-status-ok">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok" />
            live
          </span>
        </div>
        <Select
          value={hostname}
          onChange={(e) => navigate(`/monitoring/${e.target.value}`)}
          className="w-48"
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.hostname}>
              {h.hostname}
            </option>
          ))}
        </Select>
      </div>

      {metrics && !metrics.available && (
        <p className="text-sm text-status-warning">Prometheus is unreachable right now.</p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">CPU</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="CPU utilization" points={cpu} size="lg" warnAt={70} criticalAt={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="Memory utilization" points={memory} size="lg" warnAt={70} criticalAt={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Disk</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="Root filesystem" points={disk} size="lg" warnAt={75} criticalAt={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Network</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetricSparkline label="Receive" points={rx} format={formatBytesPerSec} size="lg" />
            <MetricSparkline label="Transmit" points={tx} format={formatBytesPerSec} size="lg" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
