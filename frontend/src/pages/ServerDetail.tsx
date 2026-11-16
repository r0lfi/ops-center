import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/layout/PageHeader";
import { LogViewer } from "@/components/monitoring/LogViewer";
import { EditServerDialog } from "@/components/servers/EditServerDialog";
import { HostAlerts, HostContainers, HostJobs, HostVulnerabilities } from "@/components/servers/HostTabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimeAgo } from "@/components/ui/time-ago";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Host, type OnboardingStep } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

const STEP_LABELS: Record<string, string> = {
  verify_network: "Verify network reachability",
  verify_ssh: "Verify SSH connectivity",
  record_fingerprint: "Record SSH host fingerprint",
  gather_facts: "Ansible gather_facts",
  detect_os: "Detect OS and version",
  deploy_monitoring: "Deploy monitoring components",
  baseline_patch_scan: "Baseline patch scan",
  baseline_vuln_scan: "Baseline vulnerability scan",
  prometheus_sd: "Add to Prometheus service discovery",
};

const STEP_ORDER = Object.keys(STEP_LABELS);

const TABS = [["overview", "Overview"], ["alerts", "Alerts"], ["vulnerabilities", "Vulnerabilities"], ["containers", "Containers"], ["jobs", "Jobs"], ["logs", "Logs"], ["onboarding", "Onboarding"]] as const;

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  ok: "ok",
  running: "warning",
  pending: "unknown",
  failed: "critical",
  blocked: "unknown",
};

function OnboardingStepRow({ step }: { step: OnboardingStep }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-0">
      <div>
        <p className="text-sm font-medium">{STEP_LABELS[step.step] ?? step.step}</p>
        {step.detail && <p className="mt-0.5 text-xs text-muted-foreground">{step.detail}</p>}
      </div>
      <Badge variant={STATUS_VARIANT[step.status] ?? "unknown"}>{step.status}</Badge>
    </div>
  );
}

export default function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [host, setHost] = useState<Host | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const tab = TABS.some(([value]) => value === requestedTab) ? requestedTab! : "overview";

  const refresh = useCallback(() => {
    if (!id) return;
    api.hosts
      .get(id)
      .then((data) => {
        setHost(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load server"));
  }, [id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleRetry() {
    if (!id) return;
    setRetrying(true);
    try {
      await api.hosts.verify(id);
      refresh();
    } finally {
      setRetrying(false);
    }
  }

  async function handleScan() {
    if (!id) return;
    await api.hosts.scan(id);
  }

  async function handleDelete() {
    if (!id || !host) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.hosts.remove(id);
      navigate("/servers");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete this server");
    } finally {
      setDeleting(false);
    }
  }

  if (error) {
    return <p className="text-sm text-status-critical">{error}</p>;
  }
  if (!host) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  const stepsByName = new Map(host.onboarding_steps.map((s) => [s.step, s]));
  const orderedSteps: OnboardingStep[] = STEP_ORDER.map(
    (step) => stepsByName.get(step) ?? { step, status: "pending", detail: null, started_at: null, finished_at: null },
  );
  const hasFailure = orderedSteps.some((s) => s.status === "failed");

  return (
    <div className="space-y-4">
      <PageHeader
        title={host.hostname}
        back={{ to: "/servers", label: "Servers" }}
        description={<>{host.ip_address}:{host.ssh_port} &middot; {host.environment} &middot; {host.criticality}</>}
        actions={<>
          {host.reboot_required && <Badge variant="warning">REBOOT REQUIRED</Badge>}
          <Button variant="outline" onClick={handleScan}>Run vulnerability scan</Button>
          {hasFailure && <Button variant="outline" onClick={handleRetry} disabled={retrying}>{retrying ? "Retrying..." : "Retry onboarding"}</Button>}
          {hasRole("admin") && <EditServerDialog host={host} onSaved={refresh} />}
          {hasRole("admin") && <OverflowMenu label="More server actions" items={[{ label: "Delete server", destructive: true, onSelect: () => setConfirmingDelete(true) }]} />}
        </>}
      />

      <Tabs value={tab} onValueChange={(value) => setParams(value === "overview" ? {} : { tab: value }, { replace: true })}>
        <div className="ops-scrollbar overflow-x-auto">
          <TabsList>
            {TABS.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}{value === "onboarding" && hasFailure ? " (failed)" : ""}</TabsTrigger>)}
          </TabsList>
        </div>

        <TabsContent value="overview">
          {hasFailure && <p className="mb-3 text-sm text-status-critical">Onboarding failed. See the <button type="button" className="underline" onClick={() => setParams({ tab: "onboarding" }, { replace: true })}>Onboarding tab</button>.</p>}
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">SSH user</span>
              <span>{host.ssh_user}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">OS</span>
              <span>{host.operating_system ? `${host.operating_system} ${host.os_version ?? ""}` : "unknown (requires Phase 3)"}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">Host key fingerprint</span>
              <span className="break-all font-mono text-xs">{host.ssh_host_fingerprint ?? "not recorded"}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">Reboot policy</span>
              <span>{host.reboot_policy}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">Security patch policy</span>
              <span>{host.security_patch_policy}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">Date added</span>
              <span>{formatDateTime(host.date_added)}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-3">
              <span className="text-muted-foreground">Last seen</span>
              <span><TimeAgo value={host.last_seen} /></span>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {host.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
            </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="alerts"><HostAlerts host={host} /></TabsContent>
        <TabsContent value="vulnerabilities"><HostVulnerabilities host={host} /></TabsContent>
        <TabsContent value="containers"><HostContainers host={host} /></TabsContent>
        <TabsContent value="jobs"><HostJobs host={host} /></TabsContent>
        <TabsContent value="logs"><LogViewer hostId={host.id} /></TabsContent>
        <TabsContent value="onboarding">
          <Card>
            <CardHeader><CardTitle>Onboarding</CardTitle></CardHeader>
            <CardContent className="pt-0">
              {orderedSteps.map((step) => <OnboardingStepRow key={step.step} step={step} />)}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog open={confirmingDelete} title={`Delete server "${host.hostname}"?`} confirmLabel="Delete server" busy={deleting} error={deleteError} onCancel={() => setConfirmingDelete(false)} onConfirm={handleDelete}>
        This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
