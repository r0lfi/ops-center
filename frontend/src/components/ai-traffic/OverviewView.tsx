import { useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatClock, formatDayTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { GROUP_COLOR, aiTraffic, type Overview } from "@/lib/aiTraffic";
import { CoverageList } from "./SourcesView";
import { ErrorNote, Kpi, OutcomeBadge, WindowSelect, usePoll } from "./common";

const SERIES = [
  { key: "ok", label: "OK" },
  { key: "failed", label: "Failed" },
  { key: "blocked", label: "Blocked" },
] as const;

function Ranked({ rows, empty }: { rows: { key: string; label: React.ReactNode; n: number; problems: number; sub?: string; to: string }[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(...rows.map(r => r.n), 1);
  return (
    <ul className="space-y-2">
      {rows.map(r => (
        <li key={r.key}>
          <Link to={r.to} className="block rounded-md p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatNumber(r.n)}{r.problems > 0 && <span className="text-status-warning"> · {formatNumber(r.problems)} not OK</span>}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded bg-secondary">
              <div className="h-1.5 rounded bg-primary/70" style={{ width: `${(r.n / max) * 100}%` }} />
            </div>
            {r.sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.sub}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function OverviewView() {
  const [window, setWindow] = useState("1h");
  const [data, setData] = useState<Overview | null>(null);
  const error = usePoll(async () => setData(await aiTraffic.overview(window)), 5000, [window]);
  const t = data?.totals;
  const longWindow = window.endsWith("d");
  const series = (data?.series ?? []).map(p => ({ ...p, label: longWindow ? formatDayTime(p.t) : formatClock(p.t) }));
  const down = (data?.coverage ?? []).filter(c => c.status !== "ok" && c.status !== "by_design");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WindowSelect value={window} onChange={setWindow} />
        <p className="text-xs text-muted-foreground">Live: refreshes every 5 s</p>
      </div>
      <ErrorNote error={error} />
      {!data ? <p role="status" className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          {down.length > 0 && (
            <Link to="/ai-traffic/sources" className="block rounded-md border border-status-warning/40 bg-status-warning/5 p-3 text-sm hover:bg-status-warning/10">
              <span className="font-medium text-status-warning">Partial coverage:</span> {down.length} monitoring source{down.length === 1 ? " is" : "s are"} missing or degraded.
              Counts below cover only what is observed; a low blocked count is not proof that nothing was blocked. See Capture &amp; Sources.
            </Link>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Kpi label="Active connections" value={formatNumber(data.active_connections)} hint="open, per capture" />
            <Kpi label="Connections last minute" value={formatNumber(data.requests_last_minute)} hint={`${formatNumber(data.requests_last_hour)} last hour`} />
            <Kpi label="HTTP requests" value={formatNumber(t!.requests)} hint={`in ${window}`} />
            <Kpi label="DNS lookups" value={formatNumber(t!.dns)} hint={`in ${window}`} />
            <Kpi label="OK" value={formatNumber(t!.ok)} />
            <Kpi label="Failed" value={formatNumber(t!.failed)} tone={t!.failed ? "failed" : undefined} />
            <Kpi label="Blocked (observed)" value={formatNumber(t!.blocked)} tone={t!.blocked ? "blocked" : undefined} hint="firewall, DNS, AI policy" />
            <Kpi label="Sent / received" value={<span className="text-lg">{formatBytes(t!.bytes_sent)} / {formatBytes(t!.bytes_recv)}</span>} />
          </div>

          <Card>
            <CardHeader><CardTitle>Traffic over time by outcome</CardTitle></CardHeader>
            <CardContent>
              {series.length === 0 ? <p className="text-sm text-muted-foreground">No AI network activity recorded in this window.</p> : (
                <div className="h-64" role="img" aria-label="Stacked bars of OK, failed and blocked events per time bucket">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={series} barCategoryGap={2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 4" />
                      <XAxis dataKey="label" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                      <Tooltip cursor={{ fill: "hsl(var(--accent))", opacity: 0.4 }}
                        contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                        labelStyle={{ color: "hsl(var(--foreground))" }} itemStyle={{ color: "hsl(var(--foreground))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} formatter={value => <span style={{ color: "hsl(var(--muted-foreground))" }}>{value}</span>} />
                      {SERIES.map((s, i) => (
                        <Bar key={s.key} dataKey={s.key} name={s.label} stackId="o" fill={GROUP_COLOR[s.key]} stroke="hsl(var(--card))" strokeWidth={1}
                          radius={i === SERIES.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle>Most active agents</CardTitle></CardHeader>
              <CardContent>
                <Ranked empty="No agent traffic in this window." rows={data.top_agents.map(a => ({
                  key: a.agent, label: a.agent === "-" ? <span className="italic text-muted-foreground">not attributed to an agent</span> : a.agent,
                  n: a.n, problems: a.problems, sub: formatBytes(a.bytes), to: `/ai-traffic/live?agent=${encodeURIComponent(a.agent)}&window=${window}`,
                }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Most used destinations</CardTitle></CardHeader>
              <CardContent>
                <Ranked empty="No outbound connections in this window." rows={data.top_destinations.map(d => ({
                  key: d.destination, label: <span className="font-mono text-xs">{d.destination}</span>, n: d.n, problems: d.problems,
                  sub: [d.provider, formatBytes(d.bytes)].filter(Boolean).join(" · "), to: `/ai-traffic/live?host=${encodeURIComponent(d.destination)}&window=${window}`,
                }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Models and outcomes</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Ranked empty="No model calls in this window." rows={data.top_models.map(m => ({
                  key: `${m.provider}/${m.model}`, label: m.model, n: m.n, problems: m.problems, sub: m.provider ?? undefined,
                  to: `/ai-traffic/live?model=${encodeURIComponent(m.model)}&window=${window}`,
                }))} />
                <ul className="flex flex-wrap gap-2">
                  {data.by_outcome.map(o => (
                    <li key={o.outcome}>
                      <Link to={`/ai-traffic/live?status=${o.outcome}&window=${window}`} className="inline-flex items-center gap-1 text-xs hover:underline">
                        <OutcomeBadge outcome={o.outcome} /> <span className="tabular-nums">{formatNumber(o.n)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Monitoring sources</CardTitle>
              <Link to="/ai-traffic/sources" className="text-xs text-primary hover:underline">Capture &amp; Sources</Link>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {data.sources.map(s => (
                  <li key={s.name} className="rounded-md border border-border p-2 text-sm">
                    <p className="font-medium">{s.kind === "app" ? "AI worker" : "Capture"} · {s.node}</p>
                    <p className={s.healthy ? "text-xs text-status-ok" : "text-xs text-status-critical"}>{s.healthy ? "reporting" : "not reporting"} · {formatRelativeTime(s.last_seen)}</p>
                    {(s.summary.dropped ?? 0) > 0 && <p className="text-xs text-status-warning">{formatNumber(s.summary.dropped)} events lost</p>}
                  </li>
                ))}
                {data.sources.length === 0 && <li className="text-sm text-status-warning">No monitoring source has reported yet. Nothing is being observed.</li>}
              </ul>
              <CoverageList items={data.coverage} compact />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
