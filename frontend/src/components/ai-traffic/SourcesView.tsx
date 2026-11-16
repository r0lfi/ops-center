import { useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, CircleX, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatBytes, formatDayTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { aiTraffic, downloadFile, type Capture, type CoverageItem, type SourceRow, type TrafficSettings } from "@/lib/aiTraffic";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ErrorNote, errorText, usePoll } from "./common";

const COVERAGE = {
  ok: { icon: CircleCheck, cls: "text-status-ok", label: "Covered" },
  degraded: { icon: CircleAlert, cls: "text-status-warning", label: "Degraded" },
  stale: { icon: CircleAlert, cls: "text-status-warning", label: "Not reporting" },
  missing: { icon: CircleX, cls: "text-status-critical", label: "Not covered" },
  by_design: { icon: Info, cls: "text-muted-foreground", label: "By design" },
};

export function CoverageList({ items, compact }: { items: CoverageItem[]; compact?: boolean }) {
  const shown = compact ? items.filter(i => i.status !== "ok") : items;
  if (!shown.length) return null;
  return (
    <ul className="space-y-2">
      {shown.map((c, i) => {
        const s = COVERAGE[c.status];
        const Icon = s.icon;
        return (
          <li key={i} className="flex gap-2 text-sm">
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.cls)} aria-hidden="true" />
            <div className="min-w-0">
              <p><span className={s.cls}>{s.label}:</span> {c.area}{c.node ? <span className="text-muted-foreground"> · {c.node}</span> : null}</p>
              {!compact && <p className="text-xs text-muted-foreground">{c.detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function num(v: unknown): number { return typeof v === "number" ? v : Number(v ?? 0) || 0; }

function CaptureSource({ s }: { s: SourceRow }) {
  const stats = (s.stats ?? {}) as Record<string, any>;
  const ct = stats.conntrack ?? {};
  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Collector</dt><dd>v{stats.version ?? "?"} · up since {stats.started_at ? formatDayTime(stats.started_at * 1000) : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Conntrack events</dt><dd>{ct.listening ? formatNumber(num(ct.events)) : <span className="text-status-critical">not listening{ct.error ? `: ${ct.error}` : ""}</span>}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Lost conntrack events (overruns)</dt><dd className={num(ct.overruns) ? "text-status-warning" : ""}>{formatNumber(num(ct.overruns))}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Byte counters</dt><dd>{ct.acct ? "on" : <span className="text-status-warning">off (nf_conntrack_acct=0)</span>}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Tracked flows</dt><dd>{formatNumber(num(stats.flows))}{num(stats.flows_evicted) ? <span className="text-status-warning"> · {formatNumber(num(stats.flows_evicted))} evicted</span> : null}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Delivered / buffered</dt><dd>{formatNumber(num(stats.sent))} / {formatNumber(num(stats.buffer))}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Dropped before delivery</dt><dd className={num(stats.dropped) ? "text-status-warning" : ""}>{formatNumber(num(stats.dropped))}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Last delivery error</dt><dd className="break-words">{stats.last_error ?? "—"}</dd></div>
      </dl>
      <div>
        <p className="text-xs text-muted-foreground">Watched containers</p>
        <ul className="text-xs">
          {(stats.containers ?? []).map((c: any) => <li key={c.name} className="font-mono">{c.name} · {(c.ips ?? []).join(", ")} · bridges {(c.bridges ?? []).join(", ")}</li>)}
          {!(stats.containers ?? []).length && <li className="text-status-warning">No AI container found{stats.docker_error ? `: ${stats.docker_error}` : ""}</li>}
        </ul>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Capture interfaces (header only, kernel filter: SYN/RST, DNS, TLS handshakes, ICMP errors)</p>
        <ul className="text-xs">
          {(stats.interfaces ?? []).map((i: any) => (
            <li key={i.interface} className="font-mono">{i.interface}: {i.status === "error" ? <span className="text-status-critical">{i.error}</span>
              : <>{formatNumber(num(i.packets))} packets · kernel dropped {formatNumber(num(i.kernel_dropped))}{num(i.interface_dropped) ? ` · interface dropped ${formatNumber(num(i.interface_dropped))}` : ""}</>}</li>
          ))}
          {!(stats.interfaces ?? []).length && <li>{stats.capture_enabled === false ? "Capture disabled (AI_TRAFFIC_CAPTURE=0)" : "No capture statistics yet"}</li>}
        </ul>
      </div>
    </div>
  );
}

function AppSource({ s }: { s: SourceRow }) {
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      <div><dt className="text-xs text-muted-foreground">Worker processes reporting</dt><dd>{formatNumber(s.summary.processes)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Recorded / stored</dt><dd>{formatNumber(s.summary.emitted)} / {formatNumber(s.summary.written)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Lost (queue full or DB error)</dt><dd className={s.summary.dropped ? "text-status-warning" : ""}>{formatNumber(s.summary.dropped)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Merged with capture</dt><dd>{formatNumber(s.summary.merged)}</dd></div>
    </dl>
  );
}

function Captures({ nodes }: { nodes: string[] }) {
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  const [message, setMessage] = useState("");
  const error = usePoll(async () => setCaptures((await aiTraffic.captures()).captures), 4000, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMessage("");
    try {
      await aiTraffic.requestCapture({ node: String(f.get("node")), seconds: Number(f.get("seconds")), max_mb: Number(f.get("max_mb")) });
      setCaptures((await aiTraffic.captures()).captures);
    } catch (err) { setMessage(errorText(err)); }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>PCAP capture for troubleshooting (admin)</CardTitle>
        <p className="text-xs text-muted-foreground">Passive, header-only (128 bytes per packet) capture of the AI containers' addresses on their bridges, limited in time and size and deleted automatically. No proxy, no MITM, no TLS decryption.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">Node
            <Select name="node" className="mt-1 w-44" required>{nodes.map(n => <option key={n}>{n}</option>)}</Select>
          </label>
          <label className="text-xs text-muted-foreground">Seconds
            <Input name="seconds" type="number" min={1} max={300} defaultValue={30} className="mt-1 w-24" />
          </label>
          <label className="text-xs text-muted-foreground">Max MB
            <Input name="max_mb" type="number" min={1} max={20} defaultValue={5} className="mt-1 w-20" />
          </label>
          <Button type="submit" size="sm" className="h-9" disabled={!nodes.length}>Start capture</Button>
        </form>
        {!nodes.length && <p className="text-xs text-status-warning">No collector is reporting, so no capture can run.</p>}
        <ErrorNote error={error || message} />
        {captures && captures.length > 0 && (
          <ul className="divide-y divide-border text-sm">
            {captures.map(c => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{c.node} · {c.seconds}s · {formatDayTime(c.requested_at)} by {c.requested_by}</span>
                <span className="flex items-center gap-2 text-xs">
                  <span className={c.status === "failed" ? "text-status-critical" : c.status === "done" ? "text-status-ok" : "text-primary"}>{c.status}{c.error ? `: ${c.error}` : ""}</span>
                  {c.status === "done" && <>
                    <span className="text-muted-foreground">{formatNumber(c.packets ?? 0)} packets · {formatBytes(c.size ?? 0)} · expires {formatRelativeTime(c.expires_at).replace(" ago", "")}</span>
                    <Button size="sm" variant="outline" onClick={() => void downloadFile(`/api/ai-traffic/captures/${c.id}/download`, "ai-traffic.pcap").catch(e => setMessage(errorText(e)))}>Download</Button>
                  </>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Retention({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<TrafficSettings | null>(null);
  const [saved, setSaved] = useState("");
  const error = usePoll(async () => setSettings(await aiTraffic.settings()), 60000, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaved("");
    try {
      await aiTraffic.saveSettings({ retention_days: Number(f.get("retention_days")), capture_retention_hours: Number(f.get("capture_retention_hours")) });
      setSettings(await aiTraffic.settings());
      setSaved("Saved. Older data is removed by the hourly cleanup.");
    } catch (err) { setSaved(errorText(err)); }
  }
  if (!settings) return <ErrorNote error={error} />;
  return (
    <Card>
      <CardHeader><CardTitle>Retention and storage</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{formatNumber(settings.storage.events)} events and {formatNumber(settings.storage.spans)} trace steps use {formatBytes(settings.storage.bytes)}
          {settings.storage.oldest ? `; oldest from ${formatDayTime(settings.storage.oldest)}` : ""}.</p>
        {!settings.ingest_configured && <p className="text-status-warning">AI_TRAFFIC_INGEST_TOKEN is not set on this API node: collectors cannot deliver.</p>}
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">Keep events (days)
            <Input name="retention_days" type="number" min={1} max={365} defaultValue={settings.retention_days} disabled={!isAdmin} className="mt-1 w-28" />
          </label>
          <label className="text-xs text-muted-foreground">Keep PCAPs (hours)
            <Input name="capture_retention_hours" type="number" min={1} max={168} defaultValue={settings.capture_retention_hours} disabled={!isAdmin} className="mt-1 w-28" />
          </label>
          {isAdmin && <Button type="submit" size="sm" className="h-9">Save</Button>}
        </form>
        {saved && <p role="status" className="text-xs text-muted-foreground">{saved}</p>}
        {settings.updated_by && <p className="text-xs text-muted-foreground">Last changed by {settings.updated_by} {formatRelativeTime(settings.updated_at)}</p>}
      </CardContent>
    </Card>
  );
}

export function SourcesView() {
  const { hasRole } = useAuth();
  const [data, setData] = useState<{ sources: SourceRow[]; coverage: CoverageItem[] } | null>(null);
  const error = usePoll(async () => setData(await aiTraffic.sources()), 5000, []);
  const nodes = (data?.sources ?? []).filter(s => s.kind === "capture" && s.healthy).map(s => s.node!).filter(Boolean);
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      <Card>
        <CardHeader><CardTitle>Coverage: what is and is not observed</CardTitle></CardHeader>
        <CardContent>{data ? <CoverageList items={data.coverage} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
          {data && data.sources.length === 0 && <p className="mt-2 text-sm text-status-critical">No source has ever reported. AI traffic is not being monitored yet.</p>}
        </CardContent>
      </Card>
      {(data?.sources ?? []).map(s => (
        <Card key={s.name}>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>{s.kind === "app" ? "AI worker instrumentation" : "Passive capture"} · {s.node}</CardTitle>
            <span className={cn("text-xs", s.healthy ? "text-status-ok" : "text-status-critical")}>
              {s.healthy ? "Reporting" : "Not reporting"} · last report {formatRelativeTime(s.last_seen)} · last event {formatRelativeTime(s.last_event_at ?? null)}
            </span>
          </CardHeader>
          <CardContent>{s.kind === "app" ? <AppSource s={s} /> : <CaptureSource s={s} />}</CardContent>
        </Card>
      ))}
      <Retention isAdmin={hasRole("admin")} />
      {hasRole("admin") && <Captures nodes={nodes} />}
    </div>
  );
}
