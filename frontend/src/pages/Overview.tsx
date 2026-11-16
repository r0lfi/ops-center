import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  api,
  fetchHealth,
  HEALTH_COMPONENT_LABELS,
  type AlertmanagerAlert,
  type AnsibleJob,
  type CameraStatus,
  type ContainerInfo,
  type Host,
  type HealthResponse,
  type Patch,
  type SecuritySummary,
} from "@/lib/api";
import { isExited, isUnhealthy } from "@/lib/containers";
import { fleetCounts } from "@/lib/fleet";
import { formatNumber, formatRelativeTime } from "@/lib/format";
import { TimeAgo } from "@/components/ui/time-ago";
import { severityVariant } from "@/lib/severity";

const POLL_MS = 15000;
// Scheduled service checks run every 2 minutes, so a healthy worker always has
// a recently finished job. A quarter of an hour without one means it stopped.
const WORKER_QUIET_AFTER_MS = 15 * 60 * 1000;

const COMPONENT_DESCRIPTIONS: Record<string, string> = {
  database: "PostgreSQL: stores all Ops Center data (hosts, jobs, vulnerabilities, stacks).",
  redis: "Task queue and pub/sub broker for background jobs and live updates.",
  loki: "Central log storage for managed hosts' Grafana Alloy agents.",
  security_feeds: "Refreshes CISA KEV, EPSS and vendor advisory feeds every hour.",
  prometheus: "Collects and stores metrics from every managed host.",
  alertmanager: "Routes Prometheus alerts into the Alerts page and notifications.",
  grafana: "Dashboards for the metrics Prometheus collects.",
};
const COMPONENT_LINKS: Record<string, string> = { grafana: "/grafana/" };
const MINOR_COMPONENTS = new Set(["security_feeds", "loki", "grafana"]);

type Status = "ok" | "failing" | "unknown";
type Severity = "critical" | "warning";

const STATUS_DOT: Record<Status, string> = {
  ok: "bg-status-ok",
  failing: "bg-status-critical",
  unknown: "bg-status-unknown",
};

interface OverviewData {
  health: HealthResponse | null;
  hosts: Host[] | null;
  alerts: AlertmanagerAlert[] | null;
  jobs: AnsibleJob[] | null;
  securityPatches: Patch[] | null;
  security: SecuritySummary | null;
  containers: ContainerInfo[] | null;
  cameras: CameraStatus[] | null;
}

const NO_DATA: OverviewData = {
  health: null, hosts: null, alerts: null, jobs: null, securityPatches: null, security: null, containers: null, cameras: null,
};

interface AttentionItem {
  severity: Severity;
  text: string;
  to: string;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function attentionItems(data: OverviewData, apiError: boolean): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (severity: Severity, text: string, to: string) => items.push({ severity, text, to });

  if (apiError) add("critical", "The API is not answering, so the figures below may be out of date", "/cluster");
  for (const [name, status] of Object.entries(data.health?.components ?? {})) {
    if (status === "ok") continue;
    if (name === "security_feeds") add("warning", "Security feeds have stopped updating", "/security-intelligence");
    else add(MINOR_COMPONENTS.has(name) ? "warning" : "critical", `${HEALTH_COMPONENT_LABELS[name] ?? name} is failing`, "/cluster");
  }

  const active = (data.alerts ?? []).filter((a) => a.status.state === "active");
  const criticalAlerts = active.filter((a) => a.labels.severity === "critical").length;
  if (criticalAlerts) add("critical", `${plural(criticalAlerts, "critical alert")} firing`, "/alerts?severity=critical");
  if (active.length > criticalAlerts) add("warning", `${plural(active.length - criticalAlerts, "other alert")} firing`, "/alerts?severity=other");

  if (data.hosts) {
    const fleet = fleetCounts(data.hosts, data.alerts);
    if (fleet.offline) add("critical", `${plural(fleet.offline, "server")} offline`, "/servers?status=offline");
    if (fleet.warning) add("warning", `${plural(fleet.warning, "server")} reachable, but not over SSH`, "/servers?status=no-ssh");
    if (fleet.rebootRequired) add("warning", `${plural(fleet.rebootRequired, "server")} waiting for a reboot`, "/servers?status=reboot");
  }

  if (data.security?.kev) add("critical", `${plural(data.security.kev, "known-exploited vulnerability", "known-exploited vulnerabilities")} (CISA KEV)`, "/vulnerabilities?kev=1");
  if (data.security?.critical) add("warning", `${plural(data.security.critical, "critical vulnerability", "critical vulnerabilities")}`, "/vulnerabilities?severity=critical");

  const unhealthy = (data.containers ?? []).filter(isUnhealthy).length;
  if (unhealthy) add("warning", `${plural(unhealthy, "container")} unhealthy`, "/containers/all?status=unhealthy");

  const camerasDown = (data.cameras ?? []).filter((c) => !c.reachable).length;
  if (camerasDown) add("warning", `${plural(camerasDown, "camera")} not reachable`, "/cameras");

  const failedJobs = (data.jobs ?? []).slice(0, 5).filter((j) => j.status === "failed").length;
  if (failedJobs) add("warning", `${failedJobs} of the last 5 Ansible jobs failed`, "/jobs?status=failed");

  return items.sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
}

function workerStatus(jobs: AnsibleJob[] | null): Status {
  if (!jobs) return "unknown";
  const finishedRecently = jobs.some((j) => j.finished_at && Date.now() - new Date(j.finished_at).getTime() < WORKER_QUIET_AFTER_MS);
  return finishedRecently ? "ok" : "failing";
}

function HealthTile({ name, status, description, href }: { name: string; status: Status; description: string; href?: string }) {
  const [open, setOpen] = useState(false);
  const dot = <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />;
  const className = "flex items-center gap-2 whitespace-nowrap text-sm hover:text-foreground";
  if (href) {
    return <a href={href} target="_blank" rel="noreferrer" className={`${className} hover:underline`}>{dot}{name}</a>;
  }
  return (
    <div className={open ? "w-full" : undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={className}>{dot}{name}</button>
      {open && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function SummaryCard({ title, rows }: { title: string; rows: { label: string; value: number | undefined; to: string; tone?: "ok" | Severity }[] }) {
  const tone = { ok: "text-status-ok", warning: "text-status-warning", critical: "text-status-critical" };
  return (
    <Card>
      <CardContent className="pt-4">
        <h2 className="mb-2 text-sm font-semibold">{title}</h2>
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.label}>
              <Link to={row.to} className="flex items-baseline justify-between gap-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                <span>{row.label}</span>
                <span className={`text-base font-semibold tabular-nums ${row.value ? (row.tone ? tone[row.tone] : "text-foreground") : "text-muted-foreground"}`}>
                  {row.value === undefined ? "–" : formatNumber(row.value)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const [data, setData] = useState<OverviewData>(NO_DATA);
  const [apiError, setApiError] = useState(false);
  const [staleAreas, setStaleAreas] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      // The next poll is scheduled after this one ends, so a slow backend
      // never gets a growing pile of overlapping requests from this page.
      if (document.visibilityState === "visible") {
        const [health, hosts, alerts, jobs, securityPatches, security, containers, cameras] = await Promise.allSettled([
          fetchHealth(),
          api.hosts.list(),
          api.alerts.list(),
          api.jobs.list(),
          api.patching.list({ securityOnly: true }),
          api.security.summary(),
          api.containers.list(),
          api.cameras.status(),
        ]);
        if (cancelled) return;
        const alertsAvailable = alerts.status === "fulfilled" && alerts.value.available;
        const failedAreas = [
          hosts.status === "rejected" && "servers",
          !alertsAvailable && "alerts",
          jobs.status === "rejected" && "jobs",
          securityPatches.status === "rejected" && "patches",
          security.status === "rejected" && "vulnerabilities",
          containers.status === "rejected" && "containers",
        ].filter((area): area is string => !!area);
        // A failed area keeps its last known values and is named as out of date.
        setData((previous) => ({
          health: health.status === "fulfilled" ? health.value : previous.health,
          hosts: hosts.status === "fulfilled" ? hosts.value : previous.hosts,
          alerts: alertsAvailable ? alerts.value.alerts : previous.alerts,
          jobs: jobs.status === "fulfilled" ? jobs.value : previous.jobs,
          securityPatches: securityPatches.status === "fulfilled" ? securityPatches.value : previous.securityPatches,
          security: security.status === "fulfilled" ? security.value : previous.security,
          containers: containers.status === "fulfilled" ? containers.value : previous.containers,
          // Cameras are optional, so a failure here is not reported as stale data.
          cameras: cameras.status === "fulfilled" ? cameras.value : previous.cameras,
        }));
        setApiError(health.status === "rejected");
        setStaleAreas(failedAreas);
        if (health.status === "fulfilled") setUpdatedAt(new Date().toISOString());
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    }

    const resume = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", resume);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  const loaded = updatedAt !== null;
  const fleet = data.hosts ? fleetCounts(data.hosts, data.alerts) : null;
  const attention = attentionItems(data, apiError);
  const criticalCount = attention.filter((a) => a.severity === "critical").length;
  const activeAlerts = (data.alerts ?? []).filter((a) => a.status.state === "active");
  const recentJobs = (data.jobs ?? []).slice(0, 5);
  const running = data.containers?.filter((c) => c.status === "running").length;
  const unhealthy = data.containers?.filter(isUnhealthy).length;
  const exited = data.containers?.filter(isExited).length;
  const componentStatus = (name: string): Status => {
    const status = data.health?.components[name];
    return status === undefined ? "unknown" : status === "ok" ? "ok" : "failing";
  };
  const platform = [
    { name: "API", status: (!loaded ? "unknown" : apiError ? "failing" : "ok") as Status, description: "Ops Center's own backend. If this is down, nothing else here can be trusted." },
    ...Object.keys(HEALTH_COMPONENT_LABELS).map((name) => ({
      name: HEALTH_COMPONENT_LABELS[name],
      status: componentStatus(name),
      description: COMPONENT_DESCRIPTIONS[name] ?? "",
      href: COMPONENT_LINKS[name],
    })),
    { name: "Ansible worker", status: workerStatus(data.jobs), description: "Runs playbooks: patching, scans and container actions. Shown as failing when no job has finished for 15 minutes." },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" actions={updatedAt && <span className="text-xs text-muted-foreground">Updated {formatRelativeTime(updatedAt)}</span>} />

      <section aria-labelledby="attention-heading">
        <Card className={criticalCount ? "border-status-critical/50" : attention.length ? "border-status-warning/50" : undefined}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between gap-3">
              <h2 id="attention-heading" className="flex items-center gap-3 text-lg font-semibold">
                {loaded && !attention.length && <span className="h-2.5 w-2.5 rounded-full bg-status-ok" />}
                {!loaded ? "Checking systems…" : attention.length ? "Needs attention" : "Nothing needs attention"}
              </h2>
              {loaded && attention.length > 0 && (
                <Badge variant={criticalCount ? "critical" : "warning"} title="Each line below is one area. An area can cover many findings.">
                  {criticalCount ? plural(criticalCount, "critical area") : plural(attention.length, "warning area")}
                </Badge>
              )}
            </div>
            {attention.length > 0 && (
              <ul className="mt-2 divide-y divide-border/60">
                {attention.map((item) => (
                  <li key={item.text}>
                    <Link to={item.to} className="flex items-center gap-3 py-2 text-sm hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${item.severity === "critical" ? "bg-status-critical" : "bg-status-warning"}`} />
                      <span>{item.text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {staleAreas.length > 0 && (
              <p className="mt-2 text-xs text-status-warning">Could not refresh: {staleAreas.join(", ")}. Showing the last known values.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <SummaryCard title="Servers" rows={[
          { label: "Online", value: fleet?.online, to: "/servers?status=online", tone: "ok" },
          { label: "Offline", value: fleet?.offline, to: "/servers?status=offline", tone: "critical" },
          { label: "SSH problems", value: fleet?.warning, to: "/servers?status=no-ssh", tone: "warning" },
          { label: "Waiting for reboot", value: fleet?.rebootRequired, to: "/servers?status=reboot", tone: "warning" },
        ]} />
        <SummaryCard title="Security" rows={[
          { label: "Known exploited (KEV)", value: data.security?.kev, to: "/vulnerabilities?kev=1", tone: "critical" },
          { label: "Critical vulnerabilities", value: data.security?.critical, to: "/vulnerabilities?severity=critical", tone: "critical" },
          { label: "High vulnerabilities", value: data.security?.high, to: "/vulnerabilities?severity=high", tone: "critical" },
          { label: "Pending security updates", value: data.securityPatches?.length, to: "/patching", tone: "warning" },
          { label: "Servers needing those updates", value: data.securityPatches ? new Set(data.securityPatches.map((p) => p.host_id)).size : undefined, to: "/patching", tone: "warning" },
        ]} />
        <SummaryCard title="Workloads" rows={[
          { label: "Containers running", value: running, to: "/containers/all?status=running" },
          { label: "Containers unhealthy", value: unhealthy, to: "/containers/all?status=unhealthy", tone: "warning" },
          { label: "Containers exited", value: exited, to: "/containers/all?status=exited" },
          { label: "Active alerts", value: data.alerts ? activeAlerts.length : undefined, to: "/alerts", tone: "warning" },
        ]} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Ops Center platform</h2>
        <Card>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-2 pt-4">
            {platform.map((item) => <HealthTile key={item.name} {...item} />)}
          </CardContent>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold">Active alerts</h2>
          <Card>
            <CardContent className="p-0">
              {activeAlerts.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{data.alerts ? "No active alerts." : "Alerts are not available right now."}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {activeAlerts.slice(0, 8).map((a, i) => {
                    const host = a.labels.hostname ?? a.labels.instance ?? "";
                    const params = new URLSearchParams({ alert: a.labels.alertname, ...(host ? { host } : {}) });
                    return (
                      <li key={i}>
                        <Link to={`/alerts?${params}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                          <div className="min-w-0">
                            <span className="break-words">{a.labels.alertname}</span>
                            <p className="text-xs text-muted-foreground"><TimeAgo value={a.startsAt} /></p>
                          </div>
                          <Badge variant={severityVariant(a.labels.severity)}>{host}</Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
          <Link to="/alerts" className="mt-2 inline-block text-xs text-primary hover:underline">View all alerts</Link>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">Recent Ansible jobs</h2>
          <Card>
            <CardContent className="p-0">
              {recentJobs.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No jobs yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {recentJobs.map((j) => (
                    <li key={j.id}>
                      <Link to={`/jobs/${j.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                        <div className="min-w-0">
                          <span className="break-words">{j.playbook}</span>
                          <p className="text-xs text-muted-foreground"><TimeAgo value={j.started_at ?? j.created_at} /></p>
                        </div>
                        <Badge variant={j.status === "successful" ? "ok" : j.status === "failed" ? "critical" : "unknown"}>{j.status}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Link to="/jobs" className="mt-2 inline-block text-xs text-primary hover:underline">View all jobs</Link>
        </div>
      </section>
    </div>
  );
}
