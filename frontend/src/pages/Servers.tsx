import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AddServerDialog } from "@/components/servers/AddServerDialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api, type Host } from "@/lib/api";

const CRITICALITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  low: "ok",
  medium: "unknown",
  high: "warning",
  critical: "critical",
};

function overallOnboardingStatus(host: Host): { label: string; variant: "ok" | "warning" | "critical" } {
  const steps = host.onboarding_steps;
  if (steps.length === 0) return { label: "Pending", variant: "warning" };
  if (steps.some((s) => s.status === "running")) return { label: "Onboarding...", variant: "warning" };
  if (steps.some((s) => s.status === "failed")) return { label: "Onboarding failed", variant: "critical" };
  const network = steps.find((s) => s.step === "verify_network");
  const ssh = steps.find((s) => s.step === "verify_ssh");
  if (network?.status === "ok" && ssh?.status === "ok") return { label: "Reachable", variant: "ok" };
  if (network?.status === "ok") return { label: "Reachable (no SSH auth)", variant: "warning" };
  return { label: "Unreachable", variant: "critical" };
}

export default function Servers() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.hosts
      .list()
      .then((data) => {
        setHosts(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load servers"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Servers</h1>
        <AddServerDialog onCreated={refresh} />
      </div>

      {error && <p className="text-sm text-status-critical">{error}</p>}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Hostname</th>
                <th className="px-4 py-3 font-medium">IP</th>
                <th className="px-4 py-3 font-medium">Environment</th>
                <th className="px-4 py-3 font-medium">Criticality</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {!loading && hosts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No servers yet. Click "Add Server" to onboard one.
                  </td>
                </tr>
              )}
              {hosts.map((host) => {
                const status = overallOnboardingStatus(host);
                return (
                  <tr key={host.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td className="px-4 py-3">
                      <Link to={`/servers/${host.id}`} className="font-medium text-primary hover:underline">
                        {host.hostname}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{host.ip_address}</td>
                    <td className="px-4 py-3">{host.environment}</td>
                    <td className="px-4 py-3">
                      <Badge variant={CRITICALITY_VARIANT[host.criticality] ?? "unknown"}>
                        {host.criticality}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {host.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {host.last_seen ? new Date(host.last_seen).toLocaleString() : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
