import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type ImageUpdateStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const UPDATE_STATUS_VARIANT: Record<string, "ok" | "warning" | "unknown"> = {
  up_to_date: "ok",
  update_available: "warning",
  unknown: "unknown",
};

// Shared by VulnerabilityDetailDialog (one CVE's affected-containers list)
// and the Vulnerabilities page's container search - "check for an update,
// then pull it" is the same action regardless of which page it's
// triggered from.
export function ContainerFixButton({ hostname, image }: { hostname: string; image: string }) {
  const { hasRole } = useAuth();
  const [status, setStatus] = useState<ImageUpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    try {
      // No local digest available from here (we only have the image
      // reference the container was created from, not its RepoDigests) -
      // this still answers "is there a newer tag upstream", just without
      // confirming it's newer than the *exact* running digest. Precise
      // comparison is available from the host's Images tab.
      setStatus(await api.containers.updateStatus(image, null));
    } finally {
      setChecking(false);
    }
  }

  async function pull() {
    setPulling(true);
    setPullResult(null);
    try {
      const res = await api.dockerHosts.pullImage(hostname, image);
      setPullResult(res.ok ? "Pulled - recreate the container (e.g. redeploy its stack) to start using it." : res.stderr.slice(-300));
      if (res.ok) setStatus(null);
    } finally {
      setPulling(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status ? (
        <Badge variant={UPDATE_STATUS_VARIANT[status.status] ?? "unknown"}>{status.status.replace("_", " ")}</Badge>
      ) : (
        <Button size="sm" variant="outline" disabled={checking} onClick={check}>
          {checking ? "Checking..." : "Check for image update"}
        </Button>
      )}
      {status?.detail && <span className="text-xs text-muted-foreground">{status.detail}</span>}
      {hasRole("admin") && status?.status === "update_available" && (
        <Button size="sm" variant="outline" disabled={pulling} onClick={pull}>
          {pulling ? "Pulling..." : "Pull new image"}
        </Button>
      )}
      {pullResult && <span className="text-xs text-muted-foreground">{pullResult}</span>}
    </div>
  );
}
