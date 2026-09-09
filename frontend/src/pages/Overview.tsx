import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  api,
  fetchHealth,
  type AlertmanagerAlert,
  type AnsibleJob,
  type ContainerInfo,
  type Host,
  type HealthResponse,
  type Patch,
  type SecuritySummary,
} from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

const HEALTH_COMPONENT_LABELS: Record<string, string> = {
  database: "Database",
  redis: "Redis",
  loki: "Loki",
  security_feeds: "Security feed worker",
};

const HEALTH_COMPONENT_DESCRIPTIONS: Record<string, string> = {
  database: "PostgreSQL - stores all Ops Center data (hosts, jobs, vulnerabilities, stacks, etc.).",
  redis: "Task queue and pub/sub broker for background jobs and live updates.",
  loki: "Central log storage for managed hosts' Grafana Alloy agents.",
  security_feeds: "Refreshes CISA KEV / EPSS / vendor advisory feeds hourly.",
};

interface HealthItem {
  name: string;
  ok: boolean;
  planned?: boolean;
  href?: string;
  description: string;
}

function HealthTile({ item }: { item: HealthItem }) {
  const [open, setOpen] = useState(false);
  const dot = (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        item.planned ? "bg-status-unknown" : item.ok ? "bg-status-ok" : "bg-status-critical"
      }`}
    />
  );
  const className = `flex items-center gap-2 text-sm ${item.planned ? "text-muted-foreground" : ""}`;

  if (item.href) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" className={`${className} hover:underline`}>
        {dot}
        {item.name}
      </a>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${className} hover:text-foreground`}>
        {dot}
        {item.name}
      </button>
      {open && <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>}
    </div>
  );
}

function fleetCounts(hosts: Host[]) {
  let online = 0;
  let offline = 0;
  let warning = 0;
  let rebootRequired = 0;
  for (const host of hosts) {
    const network = host.onboarding_steps.find((s) => s.step === "verify_network");
    const ssh = host.onboarding_steps.find((s) => s.step === "verify_ssh");
    if (network?.status !== "ok") {
      offline += 1;
    } else if (ssh?.status !== "ok") {
      warning += 1;
    } else {
      online += 1;
    }
    if (host.reboot_required) rebootRequired += 1;
  }
  return { total: hosts.length, online, offline, warning, rebootRequired };
}

export default function Overview() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const [jobs, setJobs] = useState<AnsibleJob[]>([]);
  const [securityPatches, setSecurityPatches] = useState<Patch[]>([]);
  const [security, setSecurity] = useState<SecuritySummary | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const result = await fetchHealth();
        if (!cancelled) {
          setHealth(result);
          setHealthError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setHealthError(err instanceof Error ? err.message : "unknown error");
        }
      }
      try {
        const hostList = await api.hosts.list();
        if (!cancelled) setHosts(hostList);
      } catch {
        // optional widget data; health error above already surfaces API issues
      }
      try {
        const alertsRes = await api.alerts.list();
        if (!cancelled) setAlerts(alertsRes.available ? alertsRes.alerts : []);
      } catch {
        // ignore
      }
      try {
        const jobList = await api.jobs.list();
        if (!cancelled) setJobs(jobList.slice(0, 5));
      } catch {
        // ignore
      }
      try {
        const patches = await api.patching.list({ securityOnly: true });
        if (!cancelled) setSecurityPatches(patches);
      } catch {
        // ignore
      }
      try {
        const summary = await api.security.summary();
        if (!cancelled) setSecurity(summary);
      } catch {
        // ignore
      }
      try {
        const containerList = await api.containers.list();
        if (!cancelled) setContainers(containerList);
      } catch {
        // ignore
      }
    }

    poll();
    const interval = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const fleet = fleetCounts(hosts);
  const activeAlerts = alerts.filter((a) => a.status.state === "active");
  const failedJobs = jobs.filter((j) => j.status === "failed");

  const fleetMetrics = [
    { label: "Total servers", value: fleet.total, href: "/servers" },
    { label: "Servers online", value: fleet.online, colorClass: "text-status-ok", href: "/servers" },
    { label: "Servers offline", value: fleet.offline, colorClass: "text-status-critical", href: "/servers" },
    { label: "Servers with warnings", value: fleet.warning, colorClass: "text-status-warning", href: "/servers" },
    {
      label: "Servers requiring reboot",
      value: fleet.rebootRequired,
      colorClass: "text-status-warning",
      href: "/servers",
    },
  ];

  const pendingMetrics = [
    {
      label: "Servers with pending security updates",
      value: new Set(securityPatches.map((p) => p.host_id)).size,
      href: "/patching",
    },
    { label: "Total pending security updates", value: securityPatches.length, href: "/patching" },
    {
      label: "Critical vulnerabilities",
      value: security?.critical ?? 0,
      warn: (security?.critical ?? 0) > 0,
      href: "/vulnerabilities",
    },
    {
      label: "High vulnerabilities",
      value: security?.high ?? 0,
      warn: (security?.high ?? 0) > 0,
      href: "/vulnerabilities",
    },
    {
      label: "CISA KEV vulnerabilities",
      value: security?.kev ?? 0,
      warn: (security?.kev ?? 0) > 0,
      href: "/vulnerabilities",
    },
    { label: "Containers running", value: containers.filter((c) => c.status === "running").length, href: "/containers" },
    {
      label: "Containers unhealthy",
      value: containers.filter((c) => c.health === "unhealthy").length,
      warn: containers.some((c) => c.health === "unhealthy"),
      href: "/containers",
    },
  ];

  const healthItems: HealthItem[] = [
    { name: "API", ok: !healthError, description: "Ops Center's own backend - if this is down, nothing else here can be trusted either." },
    ...Object.entries(health?.components ?? {}).map(([name, status]) => ({
      name: HEALTH_COMPONENT_LABELS[name] ?? name,
      ok: status === "ok",
      description: HEALTH_COMPONENT_DESCRIPTIONS[name] ?? "",
    })),
    { name: "Prometheus", ok: true, description: "Collects and stores metrics from every managed host." },
    { name: "Grafana", ok: true, href: "/grafana/", description: "Dashboards for the metrics Prometheus collects." },
    { name: "Alertmanager", ok: true, description: "Routes Prometheus alerts (disk space, service down, etc.) into the Alerts page." },
    { name: "Ansible worker", ok: true, description: "Runs Ansible playbooks - patching, scans, container actions on managed hosts." },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <Badge variant={health?.status === "ok" ? "ok" : "critical"}>
          {health?.status === "ok" ? "All systems nominal" : "Attention required"}
        </Badge>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ops Center Health
        </h2>
        <Card>
          <CardContent className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-4 lg:grid-cols-8">
            {healthItems.map((item) => (
              <HealthTile key={item.name} item={item} />
            ))}
          </CardContent>
        </Card>
        {healthError && (
          <p className="mt-2 text-sm text-status-critical">Could not reach the API: {healthError}</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Fleet Summary
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {fleetMetrics.map((m) => (
            <Link key={m.label} to={m.href}>
              <Card className="transition-colors hover:border-primary">
                <CardHeader>
                  <CardTitle>{m.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <span className={`text-2xl font-semibold ${m.colorClass ?? ""}`}>{m.value}</span>
                </CardContent>
              </Card>
            </Link>
          ))}
          {pendingMetrics.map((m) => (
            <Link key={m.label} to={m.href}>
              <Card className="transition-colors hover:border-primary">
                <CardHeader>
                  <CardTitle>{m.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <span className={`text-2xl font-semibold ${m.warn ? "text-status-warning" : ""}`}>
                    {m.value}
                  </span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Active Alerts
          </h2>
          <Card>
            <CardContent className="p-0">
              {activeAlerts.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No active alerts.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {activeAlerts.slice(0, 8).map((a, i) => (
                    <li key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <div>
                        <span>{a.labels.alertname}</span>
                        <p className="text-xs text-muted-foreground">{formatRelativeTime(a.startsAt)}</p>
                      </div>
                      <Badge variant={a.labels.severity === "critical" ? "critical" : "warning"}>
                        {a.labels.hostname ?? a.labels.instance ?? ""}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Link to="/alerts" className="mt-2 inline-block text-xs text-primary hover:underline">
            View all alerts &rarr;
          </Link>
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent Ansible Jobs {failedJobs.length > 0 && `(${failedJobs.length} failed)`}
          </h2>
          <Card>
            <CardContent className="p-0">
              {jobs.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No jobs yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {jobs.map((j) => (
                    <li key={j.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <div>
                        <span>{j.playbook}</span>
                        <p className="text-xs text-muted-foreground">{formatRelativeTime(j.started_at ?? j.created_at)}</p>
                      </div>
                      <Badge variant={j.status === "successful" ? "ok" : j.status === "failed" ? "critical" : "unknown"}>
                        {j.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Link to="/jobs" className="mt-2 inline-block text-xs text-primary hover:underline">
            View all jobs &rarr;
          </Link>
        </div>
      </section>
    </div>
  );
}
