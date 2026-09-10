import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { api, type AIAction } from "@/lib/api";

const ACTION_STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  pending: "warning",
  approved: "unknown",
  rejected: "unknown",
  executed: "ok",
  failed: "critical",
  expired: "unknown",
};

const RISK_VARIANT: Record<string, "ok" | "warning" | "critical"> = {
  low: "ok",
  medium: "warning",
  high: "critical",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function AIApprovals() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const canApprove = hasRole("operator");

  const [actions, setActions] = useState<AIAction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  function refresh() {
    api.ai.actions.list(undefined, 100).then(setActions).catch(() => {});
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  async function respond(id: string, decision: "approve" | "reject") {
    setBusy(id);
    try {
      await (decision === "approve" ? api.ai.actions.approve(id) : api.ai.actions.reject(id));
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Approvals</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How approvals work</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Review the target, proposed action and risk before approving. An AI request to restart a server
            or service must pass this approval step before it can run.
          </p>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              From Talk or web chat to execution
            </summary>
            <div className="mt-3 space-y-3 text-muted-foreground">
              <ol className="list-decimal space-y-2 pl-5">
                <li>Ask for the action in Talk or web chat. The agent may clarify whether you mean a full host reboot or a specific service restart.</li>
                <li>The agent calls an approval-gated tool. Ops Center creates a pending request with an ACT request code; the action has not run.</li>
                <li>The agent is instructed to reply that approval is required and include the code. Match that code to the request in this table.</li>
                <li>Click <strong className="text-foreground">Approve</strong> to queue execution, or <strong className="text-foreground">Reject</strong> to decline. Saying “yes” or “approved” in chat does not approve the request.</li>
              </ol>
              <p>
                Requests must be approved within <strong className="text-foreground">15 minutes</strong> of creation.
                If a request expires, ask the agent to create a new one. An identical, still-valid request may reuse the same code.
              </p>
              <p>
                <strong className="text-foreground">Pending</strong> means waiting for your decision;
                <strong className="text-foreground"> approved</strong> means authorized and queued, not finished.
                Check the final <strong className="text-foreground">executed</strong> or <strong className="text-foreground">failed</strong> status
                and the resulting host or service state before assuming the operation succeeded. This table refreshes every 10 seconds.
              </p>
            </div>
          </details>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              Who can approve?
            </summary>
            <div className="mt-3 space-y-3 text-muted-foreground">
              <p><strong className="text-foreground">Level 2 — operator or admin:</strong> service restarts, Ansible jobs, container actions and host vulnerability scans.</p>
              <p><strong className="text-foreground">Level 3 — admin only:</strong> full host reboots, arbitrary host shell commands and commands executed inside containers.</p>
              <p>The required level is assigned by the tool, not by the agent’s description of the risk. Even a read-only command submitted through the general shell tool requires level-3 approval.</p>
            </div>
          </details>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
              Technical details: instructions and enforcement
            </summary>
            <div className="mt-3 space-y-3 text-muted-foreground">
              <p>
                Agents receive instructions to explain approval requirements. The approval tool also returns
                the request code and tells the agent to report it to the user. That controls the conversation;
                the execution barrier is enforced separately by application code.
              </p>
              <ol className="list-decimal space-y-2 pl-5">
                <li>The agent runtime checks tool permissions and applicable host/environment restrictions. Calls to tools such as <code>restart_service</code>, <code>reboot_host</code> and <code>run_shell_command</code> go to <code>request_approval</code>, which stores a pending <code>AIAction</code> in PostgreSQL instead of executing it.</li>
                <li>The authenticated approval API checks your role, the required level, request status, expiry and whether the originating task was cancelled. It records the approver and timestamp, then queues a separate Celery execution task.</li>
                <li>The execution worker checks that the action is approved and its originating task is not cancelled before calling the executor. The result and execution timestamp are recorded on the action.</li>
              </ol>
              <p>
                Chat text, agent instructions and remembered preferences cannot replace the API approval.
                Built-in read-only investigation tools can run without creating an approval request.
              </p>
              <p>
                A “waiting” agent alone does not prove that an approval exists: it may be waiting for another
                agent or a provider. If the bot claims approval is required but no matching ACT code appears,
                check the task details and worker logs. The stored request is the source of truth.
              </p>
            </div>
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All AI actions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Risk</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Approved by</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {actions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No actions yet.
                    </td>
                  </tr>
                )}
                {actions.map((a) => {
                  const needsAdmin = a.approval_level >= 3;
                  const canRespond = a.status === "pending" && canApprove && (!needsAdmin || isAdmin);
                  return (
                    <tr key={a.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                      <td className="px-4 py-3">
                        <div>{a.action}</div>
                        {a.reason && <div className="text-xs text-muted-foreground">{a.reason}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={RISK_VARIANT[a.risk] ?? "unknown"}>
                          L{a.approval_level} - {a.risk}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={ACTION_STATUS_VARIANT[a.status] ?? "unknown"}>{a.status}</Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{a.request_code}</td>
                      <td className="px-4 py-3 text-muted-foreground">{a.approved_by || "-"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{timeAgo(a.requested_at)}</td>
                      <td className="px-4 py-3">
                        {a.status === "pending" && canRespond && (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => respond(a.id, "reject")}>
                              Reject
                            </Button>
                            <Button size="sm" disabled={busy === a.id} onClick={() => respond(a.id, "approve")}>
                              Approve
                            </Button>
                          </div>
                        )}
                        {a.status === "pending" && !canRespond && needsAdmin && (
                          <span className="text-xs text-muted-foreground">requires admin</span>
                        )}
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
