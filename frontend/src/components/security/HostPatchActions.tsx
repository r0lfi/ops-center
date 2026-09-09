import { useState } from "react";

import { JobOutput } from "@/components/jobs/JobOutput";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Used from the Vulnerabilities page's server search - unlike
// VulnerabilityDetailDialog's PatchHostButton (scoped to one CVE, security
// patch only), this is a whole-host action so it offers both options
// installSecurity/installAll already support.
export function HostPatchActions({ hostId, hostname }: { hostId: string; hostname: string }) {
  const { hasRole } = useAuth();
  const [armed, setArmed] = useState<"security" | "all" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  async function submit(kind: "security" | "all") {
    setSubmitting(true);
    try {
      const job = kind === "security" ? await api.patching.installSecurity(hostId) : await api.patching.installAll(hostId);
      setJobId(job.id);
      setArmed(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (!hasRole("operator")) return null;
  if (jobId) return <JobOutput jobId={jobId} />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={armed === "security" ? "destructive" : "outline"}
        disabled={submitting}
        onClick={() => (armed === "security" ? submit("security") : setArmed("security"))}
        onBlur={() => setArmed(null)}
      >
        {armed === "security" ? `Confirm security patch on ${hostname}?` : "Patch security updates"}
      </Button>
      <Button
        size="sm"
        variant={armed === "all" ? "destructive" : "outline"}
        disabled={submitting}
        onClick={() => (armed === "all" ? submit("all") : setArmed("all"))}
        onBlur={() => setArmed(null)}
      >
        {armed === "all" ? `Confirm ALL updates on ${hostname}?` : "Patch all updates"}
      </Button>
    </div>
  );
}
