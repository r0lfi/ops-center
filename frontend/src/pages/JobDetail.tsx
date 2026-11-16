import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
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
      <PageHeader title={job.playbook} description={job.target_description} back={{ to: "/jobs", label: "Jobs" }} actions={(job.status === "queued" || job.status === "running") && (
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        )} />

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
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
