import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { EditServerDialog } from "@/components/servers/EditServerDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Host, type OnboardingStep } from "@/lib/api";
import { useAuth } from "@/lib/auth";

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
    if (!confirm(`Delete server "${host.hostname}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.hosts.remove(id);
      navigate("/servers");
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
      <div>
        <Link to="/servers" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Servers
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{host.hostname}</h1>
          <p className="text-sm text-muted-foreground">
            {host.ip_address}:{host.ssh_port} &middot; {host.environment} &middot; {host.criticality}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {host.reboot_required && <Badge variant="warning">REBOOT REQUIRED</Badge>}
          <Link to={`/logs?host=${encodeURIComponent(host.hostname)}`}>
            <Button variant="outline">View logs</Button>
          </Link>
          <Button variant="outline" onClick={handleScan}>
            Run vulnerability scan
          </Button>
          {hasFailure && (
            <Button variant="outline" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying..." : "Retry onboarding"}
            </Button>
          )}
          {hasRole("admin") && <EditServerDialog host={host} onSaved={refresh} />}
          {hasRole("admin") && (
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete server"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">SSH user</span>
              <span>{host.ssh_user}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">OS</span>
              <span>{host.operating_system ? `${host.operating_system} ${host.os_version ?? ""}` : "unknown (requires Phase 3)"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Host key fingerprint</span>
              <span className="font-mono text-xs">{host.ssh_host_fingerprint ?? "not recorded"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Reboot policy</span>
              <span>{host.reboot_policy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Security patch policy</span>
              <span>{host.security_patch_policy}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Date added</span>
              <span>{new Date(host.date_added).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last seen</span>
              <span>{host.last_seen ? new Date(host.last_seen).toLocaleString() : "never"}</span>
            </div>
            <div className="flex flex-wrap gap-1 pt-1">
              {host.tags.map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Onboarding</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {orderedSteps.map((step) => (
              <OnboardingStepRow key={step.step} step={step} />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
