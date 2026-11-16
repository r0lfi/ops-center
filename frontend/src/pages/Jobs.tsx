import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { TimeAgo } from "@/components/ui/time-ago";
import { api, type AnsibleJob } from "@/lib/api";

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  successful: "ok",
  running: "warning",
  queued: "unknown",
  failed: "critical",
  cancelled: "unknown",
};

/** The scheduler has no user and marks its jobs in the target description. */
function origin(job: AnsibleJob) {
  return job.target_description.startsWith("scheduled:") || job.target_description.endsWith(", scheduled)") ? "scheduled" : "manual";
}

function Result({ job }: { job: AnsibleJob }) {
  const parts: [number, string, string][] = [
    [job.failed_hosts, "failed", "text-status-critical"],
    [job.unreachable_hosts, "unreachable", "text-status-critical"],
    [job.changed_hosts, "changed", "text-status-warning"],
    [job.successful_hosts, "ok", "text-status-ok"],
  ];
  const shown = parts.filter(([count]) => count > 0);
  if (!shown.length) return <span className="text-muted-foreground">—</span>;
  return <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">{shown.map(([count, label, color]) => <span key={label} className={color}>{count} {label}</span>)}</span>;
}

export default function Jobs() {
  const [jobs, setJobs] = useState<AnsibleJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const originFilter = params.get("origin") ?? "";
  const playbook = params.get("playbook") ?? "";

  const refresh = useCallback(() => {
    api.jobs.list().then(setJobs).catch(() => {}).finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  const playbooks = useMemo(() => [...new Set(jobs.map((job) => job.playbook))].sort(), [jobs]);
  const visible = jobs.filter((job) => (!status || job.status === status) && (!originFilter || origin(job) === originFilter) && (!playbook || job.playbook === playbook));

  return (
    <div className="space-y-4">
      <PageHeader title="Jobs" description="The 200 most recent jobs." />
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-36 space-y-1 text-xs text-muted-foreground">Started by
          <Select aria-label="Started by" value={originFilter} onChange={(e) => setFilter("origin", e.target.value)}>
            <option value="">Everyone</option><option value="manual">Manual</option><option value="scheduled">Scheduled</option>
          </Select>
        </label>
        <label className="min-w-36 space-y-1 text-xs text-muted-foreground">Status
          <Select aria-label="Status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">All statuses</option>
            {Object.keys(STATUS_VARIANT).map((name) => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
          </Select>
        </label>
        <label className="min-w-52 max-w-full space-y-1 text-xs text-muted-foreground">Playbook
          <Select aria-label="Playbook" value={playbook} onChange={(e) => setFilter("playbook", e.target.value)}>
            <option value="">All playbooks</option>
            {playbook && !playbooks.includes(playbook) && <option value={playbook}>{playbook}</option>}
            {playbooks.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </label>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="ops-card-table w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Playbook</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Result</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {loaded && visible.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {jobs.length ? "No jobs match these filters." : "No jobs yet. Run something from Automation."}
                    </td>
                  </tr>
                )}
                {visible.map((job) => (
                  <tr key={job.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td data-label="Playbook" className="px-4 py-3">
                      <Link to={`/jobs/${job.id}`} className="font-medium text-primary hover:underline">{job.playbook}</Link>
                    </td>
                    <td data-label="Target" className="px-4 py-3 text-muted-foreground">{job.target_description}</td>
                    <td data-label="Status" className="px-4 py-3"><Badge variant={STATUS_VARIANT[job.status] ?? "unknown"}>{job.status}</Badge></td>
                    <td data-label="Result" className="px-4 py-3"><Result job={job} /></td>
                    <td data-label="Started" className="whitespace-nowrap px-4 py-3 text-muted-foreground"><TimeAgo value={job.started_at} fallback="queued" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
