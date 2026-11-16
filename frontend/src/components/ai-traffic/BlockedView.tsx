import { useState } from "react";
import { Link } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDayTime, formatNumber } from "@/lib/format";
import { OUTCOMES, aiTraffic, destination, formatTimeMs, outcomeGroup, type Outcome, type TrafficEvent } from "@/lib/aiTraffic";
import { useAuth } from "@/lib/auth";
import { ErrorNote, EventDetailDialog, OutcomeBadge, WindowSelect, usePoll } from "./common";

type Blocked = Awaited<ReturnType<typeof aiTraffic.blocked>>;

const SOURCE_LABEL: Record<string, string> = { app: "AI worker", capture: "Capture" };

function evidence(e: TrafficEvent): string {
  if (e.kind === "access") return "Ops Center AI policy";
  if (e.outcome === "firewall_block") return e.reason?.startsWith("dropped on this host") ? "Conntrack (inferred local drop)" : "ICMP reject on the wire";
  if (e.outcome === "dns_block") return "DNS answer on the wire";
  return e.sources.map(s => SOURCE_LABEL[s] ?? s).join(" + ");
}

const ORDER: Outcome[] = ["firewall_block", "dns_block", "ai_access_control", "remote_reject", "dns_error", "connect_error", "timeout", "tls_error", "http_error", "unknown"];

export function BlockedView() {
  const { hasRole } = useAuth();
  const [window, setWindow] = useState("24h");
  const [data, setData] = useState<Blocked | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const error = usePoll(async () => { if (hasRole("operator")) setData(await aiTraffic.blocked(window)); }, 10000, [window]);
  if (!hasRole("operator")) return <p className="text-sm text-muted-foreground">Connection details need the operator role.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WindowSelect value={window} onChange={setWindow} />
        <Link to="/ai-traffic/sources" className="text-xs text-primary hover:underline">Which blocks can be observed?</Link>
      </div>
      <ErrorNote error={error} />
      <p className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
        Blocked means a rejection was actually observed: an ICMP "administratively prohibited" reject, a SYN this host never forwarded,
        a null DNS answer, or Ops Center's own AI/MCP policy. A timeout or a refused connection is listed as a failure, never as a block.
        No firewall on the AI nodes exports drop logs, so a rule id is shown only when a source names it.
      </p>
      {data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {ORDER.map(o => (
            <Link key={o} to={`/ai-traffic/live?status=${o}&window=${window}`} title={OUTCOMES[o].help}
              className="rounded-lg border border-border bg-card p-2 hover:bg-accent">
              <OutcomeBadge outcome={o} />
              <p className={`mt-1 text-xl font-semibold tabular-nums ${data.counts[o] ? (outcomeGroup(o) === "blocked" ? "text-status-critical" : "text-status-warning") : "text-muted-foreground"}`}>{formatNumber(data.counts[o] ?? 0)}</p>
            </Link>
          ))}
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>Blocked and failed connections</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!data ? <p className="p-4 text-sm text-muted-foreground">Loading…</p> : data.events.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">None observed in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    {["Time", "Agent", "Destination", "Result", "Confirmed reason", "Data source", "Rule"].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.events.map(e => (
                    <tr key={e.id} tabIndex={0} onClick={() => setOpen(e.id)} onKeyDown={k => k.key === "Enter" && setOpen(e.id)}
                      className="cursor-pointer border-b border-border/60 align-top hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{formatDayTime(e.ts).split(",")[0]} {formatTimeMs(e.ts)}</td>
                      <td className="px-3 py-2">{e.agent_slug ?? "—"}{e.tool && <span className="block text-xs text-muted-foreground">{e.tool}</span>}</td>
                      <td className="max-w-[240px] break-all px-3 py-2 font-mono text-xs">{destination(e)}</td>
                      <td className="px-3 py-2"><OutcomeBadge outcome={e.outcome} /></td>
                      <td className="max-w-[360px] px-3 py-2 text-xs">{e.reason ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{evidence(e)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.rule_id ?? <span className="text-muted-foreground">not available</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {data && data.approval_denials.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Rejected or expired agent actions (AI approval control)</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y divide-border text-sm">
              {data.approval_denials.map(a => (
                <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span><span className="font-medium">{a.agent_slug ?? "agent"}</span> · {a.tool}: {a.action}</span>
                  <span className="text-xs text-muted-foreground">{a.status}{a.approved_by ? ` by ${a.approved_by}` : ""} · {formatDayTime(a.requested_at)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">These never reached the network: an operator rejected them or they expired before approval.</p>
          </CardContent>
        </Card>
      )}
      <EventDetailDialog eventId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
