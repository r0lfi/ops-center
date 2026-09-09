import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api, type AnsibleJob } from "@/lib/api";

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  successful: "ok",
  running: "warning",
  queued: "unknown",
  failed: "critical",
  cancelled: "unknown",
};

export default function Jobs() {
  const [jobs, setJobs] = useState<AnsibleJob[]>([]);

  const refresh = useCallback(() => {
    api.jobs.list().then(setJobs).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Jobs</h1>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Playbook</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Changed / OK / Failed / Unreachable</th>
                <th className="px-4 py-3 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No jobs yet. Run something from Automation.
                  </td>
                </tr>
              )}
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3">
                    <Link to={`/jobs/${job.id}`} className="font-medium text-primary hover:underline">
                      {job.playbook}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{job.target_description}</td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANT[job.status] ?? "unknown"}>{job.status}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {job.changed_hosts} / {job.successful_hosts} / {job.failed_hosts} / {job.unreachable_hosts}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {job.started_at ? new Date(job.started_at).toLocaleString() : "queued"}
                  </td>
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
