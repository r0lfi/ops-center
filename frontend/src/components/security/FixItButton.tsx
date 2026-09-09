import { useState } from "react";

import { JobOutput } from "@/components/jobs/JobOutput";
import { Button } from "@/components/ui/button";
import { type AnsibleJob } from "@/lib/api";

export function FixItButton({ hostCount, onSubmit }: { hostCount: number; onSubmit: () => Promise<AnsibleJob> }) {
  const [armed, setArmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    try {
      const job = await onSubmit();
      setJobId(job.id);
      setArmed(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (jobId) return <JobOutput jobId={jobId} />;
  if (hostCount === 0) return null;

  return (
    <Button
      variant={armed ? "destructive" : "default"}
      disabled={submitting}
      onClick={() => (armed ? submit() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {submitting
        ? "Starting..."
        : armed
          ? `Confirm - patch all ${hostCount} host${hostCount === 1 ? "" : "s"}?`
          : `Fix it (${hostCount} host${hostCount === 1 ? "" : "s"})`}
    </Button>
  );
}
