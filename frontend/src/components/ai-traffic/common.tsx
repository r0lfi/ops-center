import { useEffect, useState, type ReactNode } from "react";
import { Ban, CircleAlert, CircleCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  OUTCOMES, action, aiTraffic, bytesOf, destination, formatMs, formatTimeMs, outcomeGroup,
  type Outcome, type OutcomeGroup, type Span, type TrafficEventDetail,
} from "@/lib/aiTraffic";
import { cn } from "@/lib/utils";

const GROUP_STYLE: Record<OutcomeGroup, string> = {
  ok: "border-status-ok/40 text-status-ok",
  failed: "border-status-warning/40 text-status-warning",
  blocked: "border-status-critical/50 text-status-critical",
};
const GROUP_ICON = { ok: CircleCheck, failed: CircleAlert, blocked: Ban };

/** Outcome with icon + text: never color alone. */
export function OutcomeBadge({ outcome, className }: { outcome: Outcome | string; className?: string }) {
  const group = outcomeGroup(outcome);
  const Icon = GROUP_ICON[group];
  const info = OUTCOMES[outcome as Outcome];
  return (
    <span title={info?.help} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs", GROUP_STYLE[group], className)}>
      <Icon className="h-3 w-3" aria-hidden="true" />{info?.label ?? outcome}
    </span>
  );
}

export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: OutcomeGroup }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "blocked" && "text-status-critical", tone === "failed" && "text-status-warning")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const WINDOWS = [["15m", "15 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]] as const;

export function WindowSelect({ value, onChange, label = "Time window" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="whitespace-nowrap">{label}</span>
      <Select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="h-8 w-32">
        {WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </label>
  );
}

export function ErrorNote({ error }: { error: string }) {
  return error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</p> : null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

/** Poll `load` every `ms` while mounted; returns the latest error text. */
export function usePoll(load: () => Promise<void>, ms: number, deps: unknown[]): string {
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const run = () => load().then(() => live && setError("")).catch(e => live && setError(errorText(e)));
    run();
    const timer = window.setInterval(() => { if (!document.hidden) run(); }, ms);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return error;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-xs">{children ?? "—"}</dd>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { app: "AI worker instrumentation", capture: "Passive capture (conntrack/packets)" };

export function EventDetailDialog({ eventId, onClose }: { eventId: number | null; onClose: () => void }) {
  const [data, setData] = useState<{ event: TrafficEventDetail; span_chain: Span[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null); setError("");
    if (eventId === null) return;
    aiTraffic.event(eventId).then(setData).catch(e => setError(errorText(e)));
  }, [eventId]);
  const e = data?.event;
  const detail = e?.detail ?? {};
  return (
    <Dialog open={eventId !== null} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="break-all">{e ? `${action(e)} → ${destination(e)}` : "Connection"}</DialogTitle>
          <DialogDescription>{e ? `${formatDateTime(e.ts)} · ${formatTimeMs(e.ts)}` : "Loading…"}</DialogDescription>
        </DialogHeader>
        <ErrorNote error={error} />
        {e && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <OutcomeBadge outcome={e.outcome} />
              {e.reason && <span className="break-words text-sm">{e.reason}</span>}
            </div>
            {e.outcome === "timeout" && <p className="text-xs text-muted-foreground">A timeout means no answer arrived in time. It is not shown as a block unless a firewall rejection was actually observed.</p>}
            <section>
              <h3 className="mb-2 text-sm font-medium">Who</h3>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Agent">{e.agent_slug}</Field>
                <Field label="Tool">{e.mcp_tool ? `${e.mcp_tool} (MCP)` : e.tool}</Field>
                <Field label="Provider / model">{[e.provider, e.model].filter(Boolean).join(" / ") || null}</Field>
                <Field label="Node">{e.node}</Field>
                <Field label="Container">{e.container}</Field>
                <Field label="Process (host PID)">{e.process || e.pid ? `${e.process ?? ""}${e.pid ? ` (${e.pid})` : ""}` : null}</Field>
                <Field label="Container PID">{(detail.container_pid as number | undefined) ?? null}</Field>
                <Field label="Trace">{e.trace_id ? <Link className="text-primary hover:underline" to={`/ai-traffic/trace?trace=${e.trace_id}`}>{e.trace_id.slice(0, 12)}…</Link> : null}</Field>
              </dl>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-medium">Where and what</h3>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="Source">{e.src_ip ? `${e.src_ip}:${e.src_port ?? "?"}` : null}</Field>
                <Field label="Destination">{e.dst_ip ? `${e.dst_ip}:${e.dst_port ?? "?"}` : null}</Field>
                <Field label="Host / SNI">{e.dst_host}</Field>
                <Field label="Protocol">{e.protocol ?? e.kind}</Field>
                <Field label="Request">{e.method ? `${e.method} ${e.path ?? ""}` : null}</Field>
                <Field label="HTTP status">{e.status_code}</Field>
                <Field label="Sent / received">{bytesOf(e) === null ? null : `${formatBytes(e.bytes_sent ?? 0)} / ${formatBytes(e.bytes_recv ?? 0)}`}</Field>
                <Field label="Duration (TTFB)">{`${formatMs(e.duration_ms)}${e.ttfb_ms != null ? ` (${formatMs(e.ttfb_ms)})` : ""}`}</Field>
                <Field label="Rule">{e.rule_id}</Field>
                <Field label="TLS">{detail.tls_version ? `${detail.tls_version}${detail.tls_alpn ? ` · ${(detail.tls_alpn as string[]).join(",")}` : ""}` : null}</Field>
                <Field label="DNS answers">{Array.isArray(detail.answers) && detail.answers.length ? (detail.answers as string[]).join(", ") : null}</Field>
                <Field label="NAT source">{(detail.nat_source as string | undefined) ?? null}</Field>
              </dl>
              {e.sources.includes("capture") && !e.sources.includes("app") && e.kind !== "dns" && (
                <p className="mt-2 text-xs text-muted-foreground">Seen only on the wire: the content is encrypted and not decrypted, so method, path and status are unknown.</p>
              )}
            </section>
            {data.span_chain.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Caused by</h3>
                <ol className="flex flex-wrap items-center gap-1 text-xs">
                  {data.span_chain.map((s, i) => (
                    <li key={s.span_id} className="flex items-center gap-1">
                      {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
                      <span className="rounded bg-secondary px-1.5 py-0.5">{s.kind}: {s.name}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <section>
              <h3 className="mb-2 text-sm font-medium">Original observations ({e.observations.length})</h3>
              <ul className="space-y-1 text-xs">
                {e.observations.map((o, i) => (
                  <li key={i} className="rounded bg-secondary/60 p-2 font-mono">
                    {SOURCE_LABEL[String(o.source)] ?? String(o.source)} · {String(o.obs_id)} · {String(o.outcome ?? "ok")}
                    {o.reason ? ` · ${String(o.reason)}` : ""}
                    {o.bytes_sent != null || o.bytes_recv != null ? ` · ${String(o.bytes_sent ?? "?")}↑ ${String(o.bytes_recv ?? "?")}↓` : ""}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
