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
