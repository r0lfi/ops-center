import { Link } from "react-router-dom";

import { FixItButton } from "@/components/security/FixItButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type SecurityAdvisory } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  critical: "critical",
  high: "critical",
  medium: "warning",
  low: "ok",
  unknown: "unknown",
};

export function AdvisoryDetailDialog({ advisory, onClose }: { advisory: SecurityAdvisory; onClose: () => void }) {
  const { hasRole } = useAuth();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{advisory.advisory_id}</DialogTitle>
        </DialogHeader>

        {advisory.title && <p className="text-sm">{advisory.title}</p>}

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Severity</p>
            <Badge variant={SEVERITY_VARIANT[advisory.severity] ?? "unknown"}>{advisory.severity}</Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Published</p>
            <p>{advisory.published_at ? new Date(advisory.published_at).toLocaleDateString() : "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Packages</p>
            <p className="font-mono text-xs">{advisory.packages.join(", ") || "-"}</p>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <p className="text-xs text-muted-foreground">CVEs</p>
            <p className="font-mono text-xs">{advisory.cve_ids.join(", ") || "-"}</p>
          </div>
        </div>

        {advisory.url && (
          <a href={advisory.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
            View upstream advisory &rarr;
          </a>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Affected hosts ({advisory.affected_hosts.length})
            </h3>
            {hasRole("operator") && (
              <FixItButton
                hostCount={advisory.affected_hosts.length}
                onSubmit={() => api.security.patchAdvisory(advisory.id)}
              />
            )}
          </div>
          {advisory.affected_hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hosts currently affected by this advisory's CVEs.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {advisory.affected_hosts.map((h) => (
                <li key={h.id} className="px-3 py-2 text-sm">
                  <Link to={`/servers/${h.id}`} className="font-medium hover:underline">
                    {h.hostname}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
