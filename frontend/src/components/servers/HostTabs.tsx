import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TimeAgo } from "@/components/ui/time-ago";
import { api, type AlertmanagerAlert, type AnsibleJob, type ContainerInfo, type Host, type Vulnerability } from "@/lib/api";
import { severityVariant } from "@/lib/severity";

const POLL_MS = 15000;

/** Polls while the tab is open. `null` means the first answer has not arrived. */
function usePolled<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    function refresh() {
      load().then((value) => { if (live) { setData(value); setError(null); } })
        .catch((err) => { if (live) setError(err instanceof Error ? err.message : "Could not load this list"); });
    }
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error };
}

function ListCard<T>({ data, error, empty, children }: { data: T[] | null; error: string | null; empty: string; children: (rows: T[]) => React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-0">
        {error && <p role="alert" className="p-4 text-sm text-status-critical">{error}</p>}
        {!data && !error && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {data && data.length === 0 && <p className="p-4 text-sm text-muted-foreground">{empty}</p>}
        {data && data.length > 0 && <ul className="divide-y divide-border">{children(data)}</ul>}
      </CardContent>
    </Card>
  );
}

const rowClass = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm";
const linkClass = `${rowClass} hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`;

export function HostAlerts({ host }: { host: Host }) {
  const { data, error } = usePolled<AlertmanagerAlert[]>(async () => {
    const res = await api.alerts.list();
    return res.alerts.filter((a) => a.status.state === "active" && (a.labels.hostname ?? a.labels.instance) === host.hostname);
  }, host.hostname);
  return (
    <ListCard data={data} error={error} empty="No active alerts on this server.">
      {(rows) => rows.map((a, i) => (
        <li key={i}>
          <Link to={`/alerts?${new URLSearchParams({ alert: a.labels.alertname, host: host.hostname })}`} className={linkClass}>
            <span className="min-w-0">
              <span className="font-medium">{a.labels.alertname}</span>
              <span className="block text-xs text-muted-foreground">{a.annotations.summary}</span>
            </span>
            <span className="flex items-center gap-3 text-xs text-muted-foreground"><TimeAgo value={a.startsAt} /><Badge variant={severityVariant(a.labels.severity)}>{a.labels.severity ?? "unknown"}</Badge></span>
          </Link>
        </li>
      ))}
    </ListCard>
  );
}

export function HostVulnerabilities({ host }: { host: Host }) {
  const { data, error } = usePolled<Vulnerability[]>(() => api.security.vulnerabilities({ host_id: host.id, limit: 200 }), host.id);
  return (
    <ListCard data={data} error={error} empty="No recorded vulnerabilities on this server.">
      {(rows) => rows.map((v) => (
        <li key={v.id}>
          <Link to={`/vulnerabilities?cve=${encodeURIComponent(v.cve_id)}`} className={linkClass}>
            <span className="min-w-0"><span className="font-mono text-xs text-primary">{v.cve_id}</span><span className="block break-all font-mono text-xs text-muted-foreground">{v.package_name}</span></span>
            <span className="flex items-center gap-2">{v.cisa_kev && <Badge variant="critical">KEV</Badge>}<Badge variant={severityVariant(v.severity)}>{v.severity}</Badge></span>
          </Link>
        </li>
      ))}
    </ListCard>
  );
}

export function HostContainers({ host }: { host: Host }) {
  const { data, error } = usePolled<ContainerInfo[]>(() => api.containers.list(host.hostname), host.hostname);
  return (
    <ListCard data={data} error={error} empty="No containers discovered on this server.">
      {(rows) => rows.map((c) => (
        <li key={c.id}>
          <Link to={`/containers/${encodeURIComponent(c.hostname)}/${encodeURIComponent(c.name)}`} className={linkClass}>
            <span className="min-w-0 flex-1 basis-48"><span className="font-medium">{c.name}</span><span className="block truncate font-mono text-xs text-muted-foreground" title={c.image}>{c.image}</span></span>
            <Badge variant={c.status === "running" ? "ok" : "unknown"}>{c.status}</Badge>
          </Link>
        </li>
      ))}
    </ListCard>
  );
}

const JOB_VARIANT: Record<AnsibleJob["status"], "ok" | "warning" | "critical" | "unknown"> = {
  successful: "ok", running: "warning", queued: "unknown", failed: "critical", cancelled: "unknown",
};

export function HostJobs({ host }: { host: Host }) {
  const { data, error } = usePolled<AnsibleJob[]>(async () => {
    const jobs = await api.jobs.list();
    return jobs.filter((job) => job.target_description.includes(host.hostname) || job.limit === host.hostname);
  }, host.hostname);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Jobs among the latest 200 that name this server. Jobs run against a whole group are on the <Link to="/jobs" className="text-primary hover:underline">Jobs</Link> page.</p>
      <ListCard data={data} error={error} empty="No recent jobs name this server.">
        {(rows) => rows.map((job) => (
          <li key={job.id}>
            <Link to={`/jobs/${job.id}`} className={linkClass}>
              <span className="min-w-0"><span className="break-words font-medium">{job.playbook}</span><span className="block text-xs text-muted-foreground"><TimeAgo value={job.started_at ?? job.created_at} /></span></span>
              <Badge variant={JOB_VARIANT[job.status] ?? "unknown"}>{job.status}</Badge>
            </Link>
          </li>
        ))}
      </ListCard>
    </div>
  );
}
