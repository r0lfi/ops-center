import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type DockerHost, type HostMetricsResponse } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

const POLL_MS = 15000;
const ONLINE_WITHIN_SECONDS = 600;

function hostStatus(lastSeen: string | null): { label: string; variant: "ok" | "warning" | "unknown" } {
  if (!lastSeen) return { label: "Unknown", variant: "unknown" };
  const ageSeconds = (Date.now() - new Date(lastSeen).getTime()) / 1000;
  if (ageSeconds <= ONLINE_WITHIN_SECONDS) return { label: "Online", variant: "ok" };
  return { label: "Stale", variant: "warning" };
}

export default function Containers() {
  const [hosts, setHosts] = useState<DockerHost[]>([]);
  const [metrics, setMetrics] = useState<HostMetricsResponse | null>(null);

  useEffect(() => {
    function refresh() {
      api.dockerHosts.list().then(setHosts).catch(() => {});
      api.metrics.hosts(15).then(setMetrics).catch(() => {});
    }
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Containers</h1>
          <p className="text-sm text-muted-foreground">
            Docker hosts registered in Ops Center. Open a host to manage its containers, images,
            networks and volumes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
        <Button asChild><Link to="/containers/all">List all containers</Link></Button>
        <Button variant="outline" asChild>
          <Link to="/servers">Manage hosts</Link>
        </Button>
        </div>
      </div>

      {hosts.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No Docker hosts yet. Mark a server as "Runs Docker" on the{" "}
            <Link to="/servers" className="text-primary hover:underline">
              Servers
            </Link>{" "}
            page to have it show up here.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {hosts.map((host) => {
          const status = hostStatus(host.last_seen);
          const cpu = metrics?.cpu.find((s) => s.instance === host.hostname)?.points ?? [];
          const memory = metrics?.memory.find((s) => s.instance === host.hostname)?.points ?? [];
          const disk = metrics?.disk.find((s) => s.instance === host.hostname)?.points ?? [];

          return (
            <Card key={host.hostname}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle>{host.hostname}</CardTitle>
                  <p className="text-xs text-muted-foreground">{host.environment}</p>
                </div>
                <Badge variant={status.variant}>{status.label}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div>
                    <div className="text-lg font-semibold text-status-ok">{host.running_count}</div>
                    <div className="text-xs text-muted-foreground">Running</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-status-warning">{host.stopped_count}</div>
                    <div className="text-xs text-muted-foreground">Stopped</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-status-critical">{host.unhealthy_count}</div>
                    <div className="text-xs text-muted-foreground">Unhealthy</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <MetricSparkline label="CPU" points={cpu} size="sm" warnAt={70} criticalAt={90} />
                  <MetricSparkline label="Memory" points={memory} size="sm" warnAt={70} criticalAt={90} />
                  <MetricSparkline label="Disk" points={disk} size="sm" warnAt={75} criticalAt={90} />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    {host.container_count} containers · synced {formatRelativeTime(host.last_seen)}
                  </span>
                  <Button size="sm" asChild>
                    <Link to={`/containers/${encodeURIComponent(host.hostname)}`}>Open Host</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
