import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  getToken,
  type ContainerInfo,
  type ContainerStats,
  type ContainerVulnerabilityInfo,
  type ImageUpdateStatus,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatRelativeTime } from "@/lib/format";
import { useToast } from "@/lib/toast";

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  critical: "critical",
  high: "critical",
  medium: "warning",
  low: "ok",
  unknown: "unknown",
};

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  running: "ok",
  exited: "critical",
  restarting: "warning",
  paused: "unknown",
  created: "unknown",
};

interface InspectData {
  Created?: string;
  Path?: string;
  Args?: string[];
  Config?: {
    Image?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    User?: string;
    Hostname?: string;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number };
  };
  State?: { Status?: string; Health?: { Status?: string } };
  RestartCount?: number;
  HostConfig?: { RestartPolicy?: { Name?: string } };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}

function TabLoading() {
  return <p className="text-sm text-muted-foreground">Loading...</p>;
}

function OverviewTab({ inspect, info }: { inspect: InspectData | null; info: ContainerInfo | undefined }) {
  if (!inspect) return <TabLoading />;
  const ports = Object.entries(inspect.NetworkSettings?.Ports ?? {}).filter(([, v]) => v);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <Row label="Image" value={inspect.Config?.Image ?? info?.image} mono />
          <Row label="Created" value={inspect.Created ? formatRelativeTime(inspect.Created) : "-"} />
          <Row label="Restart count" value={String(inspect.RestartCount ?? info?.restart_count ?? 0)} />
          <Row label="Restart policy" value={inspect.HostConfig?.RestartPolicy?.Name || "none"} />
          <Row label="Hostname" value={inspect.Config?.Hostname} mono />
          <Row label="Working directory" value={inspect.Config?.WorkingDir || "-"} mono />
          <Row label="User" value={inspect.Config?.User || "root (default)"} mono />
          <Row
            label="Command"
            value={(inspect.Config?.Cmd ?? []).join(" ") || "-"}
            mono
          />
          <Row
            label="Entrypoint"
            value={(inspect.Config?.Entrypoint ?? []).join(" ") || "-"}
            mono
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-2 py-4 text-sm">
          <p className="font-medium text-muted-foreground">Ports</p>
          {ports.length === 0 && <p className="text-muted-foreground">No published ports.</p>}
          {ports.map(([containerPort, bindings]) =>
            (bindings ?? []).map((b, i) => (
              <p key={`${containerPort}-${i}`} className="font-mono text-xs">
                {containerPort} → {b.HostIp || "0.0.0.0"}:{b.HostPort}
              </p>
            )),
          )}
          {inspect.Config?.Healthcheck?.Test && (
            <>
              <p className="pt-2 font-medium text-muted-foreground">Healthcheck</p>
              <p className="font-mono text-xs">{inspect.Config.Healthcheck.Test.join(" ")}</p>
              <p className="text-xs text-muted-foreground">
                interval {inspect.Config.Healthcheck.Interval ? inspect.Config.Healthcheck.Interval / 1e9 : "?"}s,
                timeout {inspect.Config.Healthcheck.Timeout ? inspect.Config.Healthcheck.Timeout / 1e9 : "?"}s,
                retries {inspect.Config.Healthcheck.Retries ?? "?"}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value || "-"}</span>
    </div>
  );
}

function StatsTab({ hostname, name }: { hostname: string; name: string }) {
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.containers
      .stats(hostname, name)
      .then(setStats)
      .finally(() => setLoading(false));
  }, [hostname, name]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          One-shot snapshot, not a live graph - historical per-container metrics for remote hosts are
          coming in a later phase.
        </p>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
      {!stats ? (
        <TabLoading />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="CPU" value={stats.cpu_percent} />
          <Stat label="Memory" value={stats.mem_usage} />
          <Stat label="Memory %" value={stats.mem_percent} />
          <Stat label="Network I/O" value={stats.net_io} />
          <Stat label="Block I/O" value={stats.block_io} />
          <Stat label="PIDs" value={stats.pids} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <Card>
      <CardContent className="py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value ?? "-"}</p>
      </CardContent>
    </Card>
  );
}

const TAIL_OPTIONS = [100, 500, 1000, 5000];

function LogsTab({ hostname, name }: { hostname: string; name: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [tail, setTail] = useState(500);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.containers
      .logs(hostname, name, tail)
      .then((r) => setLines(r.lines))
      .finally(() => setLoading(false));
  }, [hostname, name, tail]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="w-28">
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} lines
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh every 5s
        </label>
        <span className="text-xs text-muted-foreground">
          Not a live stream in this phase - refresh or enable auto-refresh above.
        </span>
      </div>
      <div className="max-h-[32rem] overflow-y-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
        {lines === null && <p className="text-muted-foreground">Loading...</p>}
        {lines?.length === 0 && <p className="text-muted-foreground">No log output.</p>}
        {lines?.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function InspectTab({ inspect }: { inspect: InspectData | null }) {
  if (!inspect) return <TabLoading />;
  return (
    <pre className="max-h-[36rem] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
      {JSON.stringify(inspect, null, 2)}
    </pre>
  );
}

function SecurityTab({ hostname, name }: { hostname: string; name: string }) {
  const [cves, setCves] = useState<ContainerVulnerabilityInfo[] | null>(null);

  useEffect(() => {
    api.containers.vulnerabilities(hostname, name).then(setCves).catch(() => setCves([]));
  }, [hostname, name]);

  if (cves === null) return <TabLoading />;

  const counts = {
    critical: cves.filter((c) => c.severity === "critical").length,
    high: cves.filter((c) => c.severity === "high").length,
    medium: cves.filter((c) => c.severity === "medium").length,
    low: cves.filter((c) => c.severity === "low").length,
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-lg font-semibold">{cves.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Critical</p>
            <p className="text-lg font-semibold text-status-critical">{counts.critical}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">High</p>
            <p className="text-lg font-semibold text-status-critical">{counts.high}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Medium</p>
            <p className="text-lg font-semibold text-status-warning">{counts.medium}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3">
            <p className="text-xs text-muted-foreground">Low</p>
            <p className="text-lg font-semibold text-status-ok">{counts.low}</p>
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">CVE</th>
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium">Package</th>
              <th className="px-4 py-3 font-medium">Installed</th>
              <th className="px-4 py-3 font-medium">Fixed</th>
              <th className="px-4 py-3 font-medium">Description</th>
            </tr>
          </thead>
          <tbody>
            {cves.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No known vulnerabilities for this container.
                </td>
              </tr>
            )}
            {cves.map((c) => (
              <tr key={c.cve_id} className="border-b border-border last:border-0 hover:bg-accent/50">
                <td className="px-4 py-3 font-mono text-xs">{c.cve_id}</td>
                <td className="px-4 py-3">
                  <Badge variant={SEVERITY_VARIANT[c.severity] ?? "unknown"}>{c.severity}</Badge>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{c.package_name}</td>
                <td className="px-4 py-3 font-mono text-xs">{c.installed_version ?? "-"}</td>
                <td className="px-4 py-3 font-mono text-xs">{c.fixed_version ?? "-"}</td>
                <td className="max-w-md px-4 py-3 text-xs text-muted-foreground">{c.description ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConsoleTab({ hostname, name }: { hostname: string; name: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed" | "error">("connecting");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    setStatus("connecting");
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 13, theme: { background: "#0b0f19" } });
    term.open(el);

    const token = getToken();
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProtocol}//${window.location.host}/api/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(name)}/console?token=${encodeURIComponent(token ?? "")}`;
    const ws = new WebSocket(url);

    ws.onopen = () => setStatus("connected");
    ws.onmessage = (event) => term.write(event.data as string);
    ws.onerror = () => setStatus("error");
    ws.onclose = () => setStatus("closed");

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    // Effect cleanup fires on tab-away (TabsContent unmounts inactive
    // tabs) as well as on unmount - either way this is the only place a
    // session ends from the browser side, so it's the one place that has
    // to close the socket to avoid leaking the relay thread/exec session
    // on the security-worker or remote-host side.
    return () => {
      dataDisposable.dispose();
      ws.close();
      term.dispose();
    };
  }, [hostname, name]);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {status === "connecting" && "Connecting..."}
        {status === "connected" && "Connected."}
        {status === "closed" && "Session closed."}
        {status === "error" && "Connection error."}
      </p>
      <div ref={containerRef} className="h-[500px] overflow-hidden rounded-md border border-border bg-[#0b0f19] p-2" />
    </div>
  );
}

function PullRecreateDialog({
  hostname,
  name,
  image,
  updateStatus,
  onDone,
}: {
  hostname: string;
  name: string;
  image: string;
  updateStatus: ImageUpdateStatus | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"idle" | "pulling" | "recreating" | "done">("idle");
  // The pull endpoint's raw `docker pull` stdout always ends in a
  // "Status: ..." line ("Image is up to date for X" or "Downloaded newer
  // image for X") - that's the only reliable way to tell the user whether
  // anything actually changed, since `ok: true` alone means "the command
  // succeeded", not "there was something new".
  const [pullSummary, setPullSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { showSuccess } = useToast();
  const busy = step === "pulling" || step === "recreating";

  function reset() {
    setStep("idle");
    setPullSummary(null);
    setError(null);
  }

  async function handleRun() {
    setError(null);
    setPullSummary(null);
    setStep("pulling");
    try {
      const pullResult = await api.dockerHosts.pullImage(hostname, image);
      if (!pullResult.ok) {
        setError(pullResult.stderr || pullResult.stdout || "pull failed");
        setStep("idle");
        return;
      }
      const statusLine = pullResult.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((line) => line.trim().startsWith("Status:"));
      setPullSummary(statusLine ? statusLine.replace(/^Status:\s*/, "").trim() : "Pull finished.");

      setStep("recreating");
      await api.containers.recreate(hostname, name, image);
      setStep("done");
      showSuccess(`${name} recreated with ${image}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to pull/recreate");
      setStep("idle");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Pull & recreate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pull new image and recreate "{name}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Pulls <span className="font-mono text-xs">{image}</span> on {hostname}, then stops and
            recreates this container from its current config (same env, ports, volumes, network,
            restart policy) under the new image. Brief downtime while it restarts.
          </p>
          {updateStatus?.status === "up_to_date" && step === "idle" && (
            <p className="text-xs">
              Registry check says this image is already up to date - this re-pulls the same digest and
              recreates anyway.
            </p>
          )}
          {pullSummary && (
            <p className="text-xs font-medium text-foreground">
              Pull result: <span className="font-mono">{pullSummary}</span>
            </p>
          )}
          {step === "done" && (
            <p className="text-xs font-medium text-status-ok">Container recreated and running.</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {step === "done" ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={handleRun} disabled={busy}>
                {step === "pulling" ? "Pulling..." : step === "recreating" ? "Recreating..." : "Pull & recreate"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ContainerDetail() {
  const { hostname = "", name = "" } = useParams<{ hostname: string; name: string }>();
  const { hasRole } = useAuth();
  const [info, setInfo] = useState<ContainerInfo | undefined>(undefined);
  const [inspect, setInspect] = useState<InspectData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<ImageUpdateStatus | null>(null);

  const refresh = useCallback(() => {
    api.containers.list(hostname).then((rows) => setInfo(rows.find((c) => c.name === name)));
    api.containers.inspect(hostname, name).then((data) => setInspect(data as InspectData));
  }, [hostname, name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const image = inspect?.Config?.Image ?? info?.image;

  // Registry-side check only, on demand (see backend's /images/update-status
  // docstring). A recreate keeps the same image *reference* (e.g. still
  // ":latest") even though the local digest just changed, so this can't
  // only depend on `image` - it needs an explicit re-check right after a
  // successful pull+recreate too (see PullRecreateDialog's onDone below),
  // or the "Update available" badge would keep showing stale.
  const checkUpdateStatus = useCallback(
    (imageRef: string) => {
      let cancelled = false;
      api.dockerHosts
        .images(hostname)
        .then((images) => {
          const match = images.find((img) => img.repo_tags.includes(imageRef));
          return api.containers.updateStatus(imageRef, match?.repo_digests[0] ?? null);
        })
        .then((status) => {
          if (!cancelled) setUpdateStatus(status);
        })
        .catch(() => {
          if (!cancelled) setUpdateStatus(null);
        });
      return () => {
        cancelled = true;
      };
    },
    [hostname],
  );

  useEffect(() => {
    if (!image) return;
    return checkUpdateStatus(image);
  }, [image, checkUpdateStatus]);

  async function runAction(action: "start" | "stop" | "restart") {
    setBusy(action);
    try {
      await api.containers[action](hostname, name);
      refresh();
    } finally {
      setBusy(null);
    }
  }

  const status = info?.status ?? inspect?.State?.Status;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to={`/containers/${encodeURIComponent(hostname)}`} className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <p className="text-xs text-muted-foreground">
              <Link to="/containers" className="hover:underline">
                Containers
              </Link>{" "}
              /{" "}
              <Link to={`/containers/${encodeURIComponent(hostname)}`} className="hover:underline">
                {hostname}
              </Link>
            </p>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold">{name}</h1>
              {status && <Badge variant={STATUS_VARIANT[status] ?? "unknown"}>{status}</Badge>}
              {updateStatus?.status === "update_available" && <Badge variant="warning">Update available</Badge>}
            </div>
          </div>
        </div>
        {hasRole("admin") && (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy === "start" || status === "running"} onClick={() => runAction("start")}>
              {busy === "start" ? "..." : "Start"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy === "stop" || status !== "running"} onClick={() => runAction("stop")}>
              {busy === "stop" ? "..." : "Stop"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy === "restart"} onClick={() => runAction("restart")}>
              {busy === "restart" ? "..." : "Restart"}
            </Button>
            {image && (
              <PullRecreateDialog
                hostname={hostname}
                name={name}
                image={image}
                updateStatus={updateStatus}
                onDone={() => {
                  refresh();
                  checkUpdateStatus(image);
                }}
              />
            )}
          </div>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="inspect">Inspect</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          {hasRole("admin") && <TabsTrigger value="console">Console</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab inspect={inspect} info={info} />
        </TabsContent>
        <TabsContent value="stats">
          <StatsTab hostname={hostname} name={name} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab hostname={hostname} name={name} />
        </TabsContent>
        <TabsContent value="inspect">
          <InspectTab inspect={inspect} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityTab hostname={hostname} name={name} />
        </TabsContent>
        {hasRole("admin") && (
          <TabsContent value="console">
            <ConsoleTab hostname={hostname} name={name} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
