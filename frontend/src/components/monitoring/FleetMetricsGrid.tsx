import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Host, type HostMetricsResponse } from "@/lib/api";

const POLL_MS = 30000;

function seriesFor(metrics: HostMetricsResponse | null, metric: "cpu" | "memory", instance: string) {
  if (!metrics) return [] as [number, number][];
  return metrics[metric].find((s) => s.instance === instance)?.points ?? [];
}

/**
 * A lighter-weight, native alternative to the embedded Grafana dashboards
 * below - CPU/memory at a glance per host, straight from Prometheus via
 * ops-api (see backend/app/api/routes/metrics.py), no Grafana round-trip.
 * Click a host to open its full metrics detail; "Wallboard" opens the
 * fullscreen, no-chrome view meant for a wall-mounted monitor.
 */
export function FleetMetricsGrid() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [metrics, setMetrics] = useState<HostMetricsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [hostList, result] = await Promise.all([api.hosts.list(), api.metrics.hosts(30)]);
        if (!cancelled) {
          setHosts(hostList);
          setMetrics(result);
        }
      } catch {
        // ignore - transient, next poll retries
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (hosts.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fleet Metrics</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {metrics && !metrics.available && (
          <p className="text-sm text-status-warning">Prometheus is unreachable right now.</p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map((h) => (
            <Link
              key={h.id}
              to={`/monitoring/${h.hostname}`}
              className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 transition-colors hover:border-primary"
            >
              <span className="col-span-2 truncate text-sm font-medium">{h.hostname}</span>
              <MetricSparkline label="CPU" points={seriesFor(metrics, "cpu", h.hostname)} size="sm" warnAt={70} criticalAt={90} />
              <MetricSparkline label="Memory" points={seriesFor(metrics, "memory", h.hostname)} size="sm" warnAt={70} criticalAt={90} />
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
