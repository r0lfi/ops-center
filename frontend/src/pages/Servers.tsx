import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
import { AddServerDialog } from "@/components/servers/AddServerDialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api, type AlertmanagerAlert, type Host } from "@/lib/api";
import { downHostnames, hostReachability } from "@/lib/fleet";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TimeAgo } from "@/components/ui/time-ago";

const CRITICALITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  low: "ok",
  medium: "unknown",
  high: "warning",
  critical: "critical",
};

function overallOnboardingStatus(host: Host, down: Set<string>): { label: string; variant: "ok" | "warning" | "critical" } {
  const steps = host.onboarding_steps;
  if (down.has(host.hostname)) return { label: "Down", variant: "critical" };
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
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const statusFilter = params.get("status") ?? "";
  const environment = params.get("environment") ?? "";
  const [search, setSearch] = useState("");

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  const refresh = useCallback(() => {
    api.alerts.list().then((data) => setAlerts(data.alerts)).catch(() => {});
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

  const down = downHostnames(alerts);
  const environments = useMemo(() => [...new Set(hosts.map((host) => host.environment))].sort(), [hosts]);
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = hosts.filter((host) => {
    // The same definitions as the Overview counts, so a link shows what it counted.
    const matchesStatus = !statusFilter || (statusFilter === "reboot" ? host.reboot_required : hostReachability(host, down) === statusFilter);
    const text = `${host.hostname} ${host.ip_address} ${host.tags.join(" ")}`.toLowerCase();
    return matchesStatus && (!environment || host.environment === environment) && words.every((word) => text.includes(word));
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Servers" actions={<AddServerDialog onCreated={refresh} />} />

      {error && <p className="text-sm text-status-critical">{error}</p>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">Search<Input aria-label="Search servers" placeholder="Hostname, address or tag…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className="min-w-40 space-y-1 text-xs text-muted-foreground">Status
          <Select aria-label="Status" value={statusFilter} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">All statuses</option><option value="online">Online</option><option value="offline">Offline</option><option value="no-ssh">SSH problems</option><option value="reboot">Waiting for reboot</option>
          </Select>
        </label>
        <label className="min-w-36 space-y-1 text-xs text-muted-foreground">Environment
          <Select aria-label="Environment" value={environment} onChange={(e) => setFilter("environment", e.target.value)}>
            <option value="">All environments</option>
            {environment && !environments.includes(environment) && <option value={environment}>{environment}</option>}
            {environments.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </label>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="ops-card-table w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Hostname</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">IP / FQDN</th>
                <th className="px-4 py-3 font-medium">Environment</th>
                <th className="px-4 py-3 font-medium">Criticality</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    {hosts.length ? "No servers match these filters." : 'No servers yet. Click "Add Server" to onboard one.'}
                  </td>
                </tr>
              )}
              {visible.map((host) => {
                const status = overallOnboardingStatus(host, down);
                return (
                  <tr key={host.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td data-label="Hostname" className="px-4 py-3">
                      <Link to={`/servers/${host.id}`} className="font-medium text-primary hover:underline">
                        {host.hostname}
                      </Link>
                    </td>
                    <td data-label="Status" className="px-4 py-3">
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </td>
                    <td data-label="IP / FQDN" className="px-4 py-3 font-mono text-xs">{host.ip_address}</td>
                    <td data-label="Environment" className="px-4 py-3">{host.environment}</td>
                    <td data-label="Criticality" className="px-4 py-3">
                      <Badge variant={CRITICALITY_VARIANT[host.criticality] ?? "unknown"}>
                        {host.criticality}
                      </Badge>
                    </td>
                    <td data-label="Tags" className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {host.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td data-label="Last seen" className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      <TimeAgo value={host.last_seen} />
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
