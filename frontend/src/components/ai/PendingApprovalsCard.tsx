import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ShieldCheck, X } from "lucide-react";

import { AgentFigure } from "@/components/ops-floor/AgentFigure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { api, type AIAction, type AIAgent } from "@/lib/api";
import { canRespondToAction } from "@/lib/aiApprovals";

const RISK_VARIANT: Record<string, "ok" | "warning" | "critical"> = { low: "ok", medium: "warning", high: "critical" };

function expiresIn(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const seconds = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m left`;
}

function target(action: AIAction): string | null {
  const args = action.arguments ?? {};
  for (const key of ["hostname", "host", "container", "service"]) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Pending agent actions, answerable in place. Same API and role rule as the Approvals page. */
export function PendingApprovalsCard({
  pending,
  agents,
  onChanged,
}: {
  pending: AIAction[];
  agents: Pick<AIAgent, "id" | "name" | "slug">[];
  onChanged: () => void | Promise<void>;
}) {
  const { hasRole } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [pending.length]);

  async function respond(id: string, decision: "approve" | "reject") {
    setBusy(id);
    setError("");
    try {
      await (decision === "approve" ? api.ai.actions.approve(id) : api.ai.actions.reject(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
      await onChanged();
    }
  }

  const rows = [...pending].sort((a, b) => b.approval_level - a.approval_level || a.requested_at.localeCompare(b.requested_at));

  return (
    <Card className={rows.length > 0 ? "border-status-warning/60" : undefined}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-status-warning" />
            Pending approvals
            {rows.length > 0 && <Badge variant="warning">{rows.length}</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">Actions agents want to run. Approve queues execution; nothing runs before that.</p>
        </div>
        <Link to="/ai-agents/approvals" className="text-xs text-primary hover:underline">
          History and details →
        </Link>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {rows.length === 0 && <p className="text-muted-foreground">Nothing is waiting for approval.</p>}
        {rows.map((a) => {
          const agent = agents.find((ag) => ag.id === a.agent_id);
          const canRespond = canRespondToAction(a, hasRole);
          const left = expiresIn(a.expires_at, now);
          const host = target(a);
          return (
            <div key={a.id} className="flex flex-col gap-2 rounded-md border border-border p-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={RISK_VARIANT[a.risk] ?? "unknown"}>L{a.approval_level} - {a.risk}</Badge>
                  <span className="font-medium">{a.action}</span>
                  {host && <span className="font-mono text-xs text-muted-foreground">{host}</span>}
                </div>
                {a.reason && <p className="text-xs text-muted-foreground">{a.reason}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {agent && <span className="flex items-center gap-1"><AgentFigure slug={agent.slug} size={14} />{agent.name}</span>}
                  <span className="font-mono">{a.request_code}</span>
                  {left && <span className={left === "expired" ? "text-status-critical" : undefined}>{left}</span>}
                  {a.task_id && (
                    <Link className="text-primary hover:underline" to={`/ai-agents/tasks?task=${encodeURIComponent(a.task_id)}`}>
                      task
                    </Link>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                {canRespond ? (
                  <>
                    <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => respond(a.id, "reject")}>
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                    <Button size="sm" disabled={busy === a.id || left === "expired"} onClick={() => respond(a.id, "approve")}>
                      <Check className="h-3.5 w-3.5" />
                      Approve
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">{a.approval_level >= 3 ? "requires admin" : "requires operator"}</span>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
