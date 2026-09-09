import { ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";

import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { ServiceStatusGrid } from "@/components/monitoring/ServiceStatusGrid";
import { Select } from "@/components/ui/select";
import { api, type Host, type HostMetricsResponse, type ServiceStatus } from "@/lib/api";
import { formatBytesPerSec } from "@/lib/format";

const LIVE_POLL_MS = 10000;

function seriesFor(metrics: HostMetricsResponse | null, metric: keyof HostMetricsResponse, instance: string) {
  if (!metrics || metric === "available") return [] as [number, number][];
  const list = metrics[metric] as { instance: string; points: [number, number][] }[];
  return list.find((s) => s.instance === instance)?.points ?? [];
}

/**
 * Chrome-free, no sidebar (see App.tsx) - meant to be opened fullscreen on
 * a wall-mounted monitor. Grid of every host by default; click one to
 * focus on it full-size without leaving the page (no navigation chrome to
 * click "back" through from across a room).
 */
export default function Wallboard() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [metrics, setMetrics] = useState<HostMetricsResponse | null>(null);
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [hostList, result, serviceResult] = await Promise.all([
          api.hosts.list(),
          api.metrics.hosts(60),
          api.metrics.services(),
        ]);
        if (!cancelled) {
          setHosts(hostList);
          setMetrics(result);
          setServices(serviceResult.services);
        }
      } catch {
        // ignore - transient, next poll retries
      }
    }

    poll();
    const interval = setInterval(poll, LIVE_POLL_MS);
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(clock);
    };
  }, []);

  const focusedHost = hosts.find((h) => h.hostname === focused) ?? null;

  return (
    <div className="min-h-screen space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-semibold tracking-wide">Ops Center Wallboard</h1>
          <span className="flex items-center gap-1.5 text-xs text-status-ok">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok" />
            live
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Select
            value={focused ?? ""}
            onChange={(e) => setFocused(e.target.value || null)}
            className="w-56"
          >
            <option value="">All servers</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.hostname}>
                {h.hostname}
              </option>
            ))}
          </Select>
          <span className="font-mono text-lg tabular-nums text-muted-foreground">
            {now.toLocaleTimeString()}
          </span>
        </div>
      </div>

      {metrics && !metrics.available && (
        <p className="text-sm text-status-warning">Prometheus is unreachable right now.</p>
      )}

      {focusedHost ? (
        <div>
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-3xl font-semibold">{focusedHost.hostname}</h2>
            <button
              onClick={() => setFocused(null)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
              all servers
            </button>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <MetricSparkline
              label="CPU"
              points={seriesFor(metrics, "cpu", focusedHost.hostname)}
              size="lg"
              warnAt={70}
              criticalAt={90}
            />
            <MetricSparkline
              label="Memory"
              points={seriesFor(metrics, "memory", focusedHost.hostname)}
              size="lg"
              warnAt={70}
              criticalAt={90}
            />
            <MetricSparkline
              label="Disk"
              points={seriesFor(metrics, "disk", focusedHost.hostname)}
              size="lg"
              warnAt={75}
              criticalAt={90}
            />
            <div className="space-y-4">
              <MetricSparkline
                label="Network receive"
                points={seriesFor(metrics, "network_rx", focusedHost.hostname)}
                format={formatBytesPerSec}
                size="lg"
              />
              <MetricSparkline
                label="Network transmit"
                points={seriesFor(metrics, "network_tx", focusedHost.hostname)}
                format={formatBytesPerSec}
                size="lg"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {hosts.map((host) => (
            <button
              key={host.id}
              onClick={() => setFocused(host.hostname)}
              className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary"
            >
              <h3 className="mb-3 text-lg font-semibold">{host.hostname}</h3>
              <div className="grid grid-cols-2 gap-2">
                <MetricSparkline
                  label="CPU"
                  points={seriesFor(metrics, "cpu", host.hostname)}
                  size="md"
                  warnAt={70}
                  criticalAt={90}
                />
                <MetricSparkline
                  label="Memory"
                  points={seriesFor(metrics, "memory", host.hostname)}
                  size="md"
                  warnAt={70}
                  criticalAt={90}
                />
                <MetricSparkline
                  label="Disk"
                  points={seriesFor(metrics, "disk", host.hostname)}
                  size="md"
                  warnAt={75}
                  criticalAt={90}
                />
                <MetricSparkline
                  label="Network rx"
                  points={seriesFor(metrics, "network_rx", host.hostname)}
                  format={formatBytesPerSec}
                  size="md"
                />
              </div>
            </button>
          ))}
        </div>
      )}

      {!focusedHost && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-muted-foreground">Services</h2>
          <ServiceStatusGrid services={services} size="lg" />
        </div>
      )}
    </div>
  );
}
