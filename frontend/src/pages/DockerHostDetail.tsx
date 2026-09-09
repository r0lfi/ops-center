import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { HostContainersTable } from "@/components/containers/HostContainersTable";
import { StacksSection } from "@/components/containers/StacksSection";
import { MetricSparkline } from "@/components/monitoring/MetricSparkline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  type DockerEventInfo,
  type DockerHost,
  type HostMetricsResponse,
  type ImageInfo,
  type ImageUpdateStatus,
  type NetworkInfo,
  type VolumeInfo,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatRelativeTime } from "@/lib/format";

const POLL_MS = 15000;
const ONLINE_WITHIN_SECONDS = 600;
// Only ops-host has a continuous event stream (a background thread in
// security-worker - see security/events.py); every other managed host has
// no persistent channel to poll, so its Events tab is a one-shot bounded
// window instead of a live table. UX-only distinction, not a security
// boundary - the actual branching lives on the backend.
const LOCAL_DOCKER_HOSTNAME = "ops-host";
const EVENT_TYPES = ["container", "image", "network", "volume", "daemon"] as const;

function hostStatus(lastSeen: string | null): { label: string; variant: "ok" | "warning" | "unknown" } {
  if (!lastSeen) return { label: "Unknown", variant: "unknown" };
  const ageSeconds = (Date.now() - new Date(lastSeen).getTime()) / 1000;
  if (ageSeconds <= ONLINE_WITHIN_SECONDS) return { label: "Online", variant: "ok" };
  return { label: "Stale", variant: "warning" };
}

const UPDATE_STATUS_VARIANT: Record<string, "ok" | "warning" | "unknown"> = {
  up_to_date: "ok",
  update_available: "warning",
  unknown: "unknown",
};

function ImageUpdateCell({ hostname, image }: { hostname: string; image: ImageInfo }) {
  const { hasRole } = useAuth();
  const [status, setStatus] = useState<ImageUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string | null>(null);

  const tag = image.repo_tags[0];

  async function check() {
    if (!tag) return;
    setChecking(true);
    try {
      const localDigest = image.repo_digests[0]?.split("@")[1] ?? null;
      const result = await api.containers.updateStatus(tag, localDigest);
      setStatus(result);
    } finally {
      setChecking(false);
    }
  }

  async function pull() {
    if (!tag) return;
    setPulling(true);
    setPullResult(null);
    try {
      const res = await api.dockerHosts.pullImage(hostname, tag);
      setPullResult(res.ok ? "Pulled." : res.stderr.slice(-300));
      if (res.ok) setStatus(null);
    } finally {
      setPulling(false);
    }
  }

  if (!tag) return <span className="text-xs text-muted-foreground">-</span>;

  return (
    <div className="flex items-center gap-2">
      {status ? (
        <Badge variant={UPDATE_STATUS_VARIANT[status.status]}>{status.status.replace("_", " ")}</Badge>
      ) : (
        <Button size="sm" variant="outline" disabled={checking} onClick={check}>
          {checking ? "Checking..." : "Check for update"}
        </Button>
      )}
      {status?.detail && <span className="text-xs text-muted-foreground">{status.detail}</span>}
      {hasRole("admin") && status?.status === "update_available" && (
        <Button size="sm" variant="outline" disabled={pulling} onClick={pull}>
          {pulling ? "Pulling..." : "Pull new image"}
        </Button>
      )}
      {pullResult && <span className="text-xs text-muted-foreground">{pullResult}</span>}
    </div>
  );
}

function ImagesTab({ hostname }: { hostname: string }) {
  const [images, setImages] = useState<ImageInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setImages(null);
    setError(null);
    api
      .dockerHosts.images(hostname)
      .then(setImages)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load images"));
  }, [hostname]);

  if (error) return <p className="text-sm text-status-critical">{error}</p>;
  if (images === null) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">Repository:Tag</th>
            <th className="px-4 py-3 font-medium">Image ID</th>
            <th className="px-4 py-3 font-medium">Created</th>
            <th className="px-4 py-3 font-medium">Size</th>
            <th className="px-4 py-3 font-medium">Containers using image</th>
            <th className="px-4 py-3 font-medium">Update status</th>
          </tr>
        </thead>
        <tbody>
          {images.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                No images found.
              </td>
            </tr>
          )}
          {images.map((img) => (
            <tr key={img.id} className="border-b border-border last:border-0 hover:bg-accent/50">
              <td className="px-4 py-3 font-mono text-xs">
                {img.repo_tags.length > 0 ? img.repo_tags.join(", ") : <span className="text-muted-foreground">&lt;none&gt;</span>}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {img.id.replace("sha256:", "").slice(0, 12)}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(img.created)}</td>
              <td className="px-4 py-3">{formatBytes(img.size_bytes)}</td>
              <td className="px-4 py-3">{img.container_count}</td>
              <td className="px-4 py-3">
                <ImageUpdateCell hostname={hostname} image={img} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NetworksTab({ hostname }: { hostname: string }) {
  const [networks, setNetworks] = useState<NetworkInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNetworks(null);
    setError(null);
    api
      .dockerHosts.networks(hostname)
      .then(setNetworks)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load networks"));
  }, [hostname]);

  if (error) return <p className="text-sm text-status-critical">{error}</p>;
  if (networks === null) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Driver</th>
            <th className="px-4 py-3 font-medium">Scope</th>
            <th className="px-4 py-3 font-medium">Subnet</th>
            <th className="px-4 py-3 font-medium">Gateway</th>
            <th className="px-4 py-3 font-medium">Containers</th>
          </tr>
        </thead>
        <tbody>
          {networks.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                No networks found.
              </td>
            </tr>
          )}
          {networks.map((net) => (
            <tr key={net.id} className="border-b border-border last:border-0 hover:bg-accent/50">
              <td className="px-4 py-3 font-medium">{net.name}</td>
              <td className="px-4 py-3">{net.driver}</td>
              <td className="px-4 py-3 text-muted-foreground">{net.scope}</td>
              <td className="px-4 py-3 font-mono text-xs">{net.subnet ?? "-"}</td>
              <td className="px-4 py-3 font-mono text-xs">{net.gateway ?? "-"}</td>
              <td className="px-4 py-3 text-muted-foreground">
                {net.containers.length === 0 ? "-" : net.containers.map((c) => c.name).join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VolumesTab({ hostname }: { hostname: string }) {
  const [volumes, setVolumes] = useState<VolumeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVolumes(null);
    setError(null);
    api
      .dockerHosts.volumes(hostname)
      .then(setVolumes)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load volumes"));
  }, [hostname]);

  if (error) return <p className="text-sm text-status-critical">{error}</p>;
  if (volumes === null) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Driver</th>
            <th className="px-4 py-3 font-medium">Mountpoint</th>
            <th className="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {volumes.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                No volumes found.
              </td>
            </tr>
          )}
          {volumes.map((vol) => (
            <tr key={vol.name} className="border-b border-border last:border-0 hover:bg-accent/50">
              <td className="px-4 py-3 font-mono text-xs">{vol.name}</td>
              <td className="px-4 py-3">{vol.driver}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{vol.mountpoint}</td>
              <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(vol.created)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventsTab({ hostname }: { hostname: string }) {
  const isLocal = hostname === LOCAL_DOCKER_HOSTNAME;
  const [events, setEvents] = useState<DockerEventInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      api.dockerHosts
        .events(hostname, typeFilter || undefined)
        .then((rows) => !cancelled && setEvents(rows))
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "failed to load events"));
    }

    setEvents(null);
    setError(null);
    refresh();

    if (!isLocal) return;
    const interval = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hostname, isLocal, typeFilter, refreshKey]);

  if (error) return <p className="text-sm text-status-critical">{error}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <select
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {isLocal ? (
          <span className="text-xs text-muted-foreground">Live, refreshes every 10s</span>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Last hour</span>
            <Button size="sm" variant="outline" onClick={() => setRefreshKey((k) => k + 1)}>
              Refresh
            </Button>
          </div>
        )}
      </div>

      {events === null ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No events found.
                  </td>
                </tr>
              )}
              {events.map((ev, idx) => {
                const attrs = ev.actor_attributes || {};
                const label = attrs.name || attrs.image || ev.actor_id?.slice(0, 12) || "-";
                return (
                  <tr
                    key={`${ev.occurred_at}-${ev.actor_id}-${idx}`}
                    className="border-b border-border last:border-0 hover:bg-accent/50"
                  >
                    <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(ev.occurred_at)}</td>
                    <td className="px-4 py-3">
                      <Badge variant="unknown">{ev.event_type}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{ev.action}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DockerHostDetail() {
  const { hostname = "" } = useParams<{ hostname: string }>();
  const [host, setHost] = useState<DockerHost | null>(null);
  const [metrics, setMetrics] = useState<HostMetricsResponse | null>(null);

  useEffect(() => {
    function refresh() {
      api.dockerHosts.get(hostname).then(setHost).catch(() => {});
    }
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [hostname]);

  useEffect(() => {
    let cancelled = false;
    api
      .metrics.hosts(60, hostname)
      .then((m) => !cancelled && setMetrics(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hostname]);

  const status = hostStatus(host?.last_seen ?? null);
  const cpu = metrics?.cpu.find((s) => s.instance === hostname)?.points ?? [];
  const memory = metrics?.memory.find((s) => s.instance === hostname)?.points ?? [];
  const disk = metrics?.disk.find((s) => s.instance === hostname)?.points ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/containers" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Docker Host</p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{hostname}</h1>
            <Badge variant={status.variant}>{status.label.toUpperCase()}</Badge>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Containers</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold">{host?.container_count ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Running</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-ok">{host?.running_count ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Stopped</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-warning">{host?.stopped_count ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Unhealthy</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-critical">{host?.unhealthy_count ?? "-"}</span>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">CPU</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="CPU utilization" points={cpu} size="md" warnAt={70} criticalAt={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Memory</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="Memory utilization" points={memory} size="md" warnAt={70} criticalAt={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Disk</CardTitle>
          </CardHeader>
          <CardContent>
            <MetricSparkline label="Root filesystem" points={disk} size="md" warnAt={75} criticalAt={90} />
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="containers">
        <TabsList>
          <TabsTrigger value="containers">Containers</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
          <TabsTrigger value="networks">Networks</TabsTrigger>
          <TabsTrigger value="volumes">Volumes</TabsTrigger>
          <TabsTrigger value="stacks">Stacks</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="containers">
          <HostContainersTable hostname={hostname} />
        </TabsContent>
        <TabsContent value="images">
          <ImagesTab hostname={hostname} />
        </TabsContent>
        <TabsContent value="networks">
          <NetworksTab hostname={hostname} />
        </TabsContent>
        <TabsContent value="volumes">
          <VolumesTab hostname={hostname} />
        </TabsContent>
        <TabsContent value="stacks">
          <StacksSection hostname={hostname} />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab hostname={hostname} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
