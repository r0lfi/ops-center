import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { JobOutput } from "@/components/jobs/JobOutput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AnsibleJob } from "@/lib/api";

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<AnsibleJob | null>(null);

  useEffect(() => {
    if (!id) return;
    api.jobs.get(id).then(setJob).catch(() => {});
  }, [id]);

  async function handleCancel() {
    if (!id) return;
    await api.jobs.cancel(id);
    api.jobs.get(id).then(setJob).catch(() => {});
  }

  if (!job || !id) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="space-y-4">
      <Link to="/jobs" className="text-sm text-muted-foreground hover:text-foreground">
        &larr; Jobs
      </Link>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{job.playbook}</h1>
          <p className="text-sm text-muted-foreground">{job.target_description}</p>
        </div>
        {(job.status === "queued" || job.status === "running") && (
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Changed</p>
            <p className="text-lg font-semibold">{job.changed_hosts}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Successful</p>
            <p className="text-lg font-semibold text-status-ok">{job.successful_hosts}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Failed</p>
            <p className="text-lg font-semibold text-status-critical">{job.failed_hosts}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Unreachable</p>
            <p className="text-lg font-semibold text-status-warning">{job.unreachable_hosts}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Output
            <Badge>{job.status}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <JobOutput jobId={id} />
        </CardContent>
      </Card>
    </div>
  );
}
