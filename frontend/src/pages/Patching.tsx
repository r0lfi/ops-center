import { Link } from "react-router-dom";
import { Fragment, useEffect, useState } from "react";

import { JobOutput } from "@/components/jobs/JobOutput";
import { PatchGroupsSection } from "@/components/patching/PatchGroupsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type Host, type PatchScan } from "@/lib/api";

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  critical: "critical",
  important: "critical",
  moderate: "warning",
  low: "ok",
  unknown: "unknown",
};

interface ConfirmState {
  host: Host;
  action: "patch-security" | "patch-all";
}

export default function Patching() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [scans, setScans] = useState<Record<string, PatchScan | null>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  async function refresh() {
    const hostList = await api.hosts.list();
    setHosts(hostList);
    const entries = await Promise.all(
      hostList.map(async (h) => [h.id, await api.patching.hostScan(h.id).catch(() => null)] as const),
    );
    setScans(Object.fromEntries(entries));
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  async function handleCheck(host: Host) {
    const job = await api.patching.check(host.id);
    setActiveJobId(job.id);
  }

  async function handleConfirmedInstall() {
    if (!confirm) return;
    const job =
      confirm.action === "patch-security"
        ? await api.patching.installSecurity(confirm.host.id)
        : await api.patching.installAll(confirm.host.id);
    setConfirm(null);
    setActiveJobId(job.id);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">Patching</h1><Button asChild variant="outline"><Link to="/patching/reports">Patch reports</Link></Button></div>

      <PatchGroupsSection />

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Host</th>
                <th className="px-4 py-3 font-medium">Pending</th>
                <th className="px-4 py-3 font-medium">Security</th>
                <th className="px-4 py-3 font-medium">Reboot</th>
                <th className="px-4 py-3 font-medium">Last scan</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => {
                const scan = scans[host.id];
                const isExpanded = expanded === host.id;
                return (
                  <Fragment key={host.id}>
                    <tr className="border-b border-border hover:bg-accent/50">
                      <td className="px-4 py-3">
                        <button
                          className="font-medium text-primary hover:underline"
                          onClick={() => setExpanded(isExpanded ? null : host.id)}
                        >
                          {host.hostname}
                        </button>
                      </td>
                      <td className="px-4 py-3">{scan?.pending_count ?? "-"}</td>
                      <td className="px-4 py-3">
                        {scan && scan.pending_security_count > 0 ? (
                          <Badge variant="warning">{scan.pending_security_count}</Badge>
                        ) : (
                          (scan?.pending_security_count ?? "-")
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {scan?.reboot_required && <Badge variant="warning">required</Badge>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {scan?.completed_at ? new Date(scan.completed_at).toLocaleString() : "never"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => handleCheck(host)}>
                            Check
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirm({ host, action: "patch-security" })}
                          >
                            Security
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => setConfirm({ host, action: "patch-all" })}
                          >
                            All
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && scan && (
                      <tr className="border-b border-border bg-background/50">
                        <td colSpan={6} className="px-4 py-3">
                          {scan.patches.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No pending patches.</p>
                          ) : (
                            <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="py-1 pr-4">Package</th>
                                  <th className="py-1 pr-4">Fixed version</th>
                                  <th className="py-1 pr-4">Severity</th>
                                  <th className="py-1 pr-4">Advisory</th>
                                  <th className="py-1 pr-4">Repo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {scan.patches.map((p) => (
                                  <tr key={p.id}>
                                    <td className="py-1 pr-4 font-mono">{p.package_name}</td>
                                    <td className="py-1 pr-4 font-mono">{p.fixed_version ?? "-"}</td>
                                    <td className="py-1 pr-4">
                                      <Badge variant={SEVERITY_VARIANT[p.severity] ?? "unknown"}>
                                        {p.severity}
                                      </Badge>
                                    </td>
                                    <td className="py-1 pr-4">{p.advisory_id ?? "-"}</td>
                                    <td className="py-1 pr-4">{p.repository ?? "-"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm?.action === "patch-all" ? "Install ALL updates" : "Install security updates"} on{" "}
              {confirm?.host.hostname}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-status-warning">
            This will modify the host. {confirm?.action === "patch-all" && "This includes non-security updates."}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmedInstall}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeJobId && (
        <Card>
          <CardContent className="pt-4">
            <JobOutput jobId={activeJobId} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
