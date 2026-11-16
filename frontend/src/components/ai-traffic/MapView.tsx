import { memo, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Globe2, Minus, Network, Pause, Play, Plus, RotateCcw, Server, X } from "lucide-react";

import { EventDetailDialog, ErrorNote, OutcomeBadge, WindowSelect, usePoll } from "@/components/ai-traffic/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { aiTraffic, formatTimeMs, type MapGroup, type OutcomeGroup, type TrafficEvent, type TrafficMapData } from "@/lib/aiTraffic";
import { useAskOpsPageContext } from "@/lib/askOps";
import { formatBytes } from "@/lib/format";
import { project } from "@/lib/mapProjection";
import { cn } from "@/lib/utils";
import { WORLD_COUNTRIES } from "@/lib/worldMap";

const STATUS_COLOR: Record<OutcomeGroup, string> = { ok: "hsl(var(--primary))", failed: "hsl(var(--status-warning))", blocked: "hsl(var(--status-critical))" };
const STATUS_LABEL: Record<OutcomeGroup, string> = { ok: "Allowed", failed: "Failed", blocked: "Blocked" };
const RANK: Record<OutcomeGroup, number> = { ok: 0, failed: 1, blocked: 2 };
const FULL = { x: 0, y: 135, w: 1024, h: 590 };
// GeoIP (DB-IP) English names that differ from the Natural Earth outline names.
const COUNTRY_ALIAS: Record<string, string> = {
  "United States": "United States of America", "Bosnia and Herzegovina": "Bosnia and Herz.", "Dominican Republic": "Dominican Rep.",
  "DR Congo": "Dem. Rep. Congo", "Congo Republic": "Congo", "Central African Republic": "Central African Rep.", "South Sudan": "S. Sudan",
  "North Macedonia": "Macedonia", "Czech Republic": "Czechia", "Ivory Coast": "Côte d'Ivoire", "Eswatini": "eSwatini",
};
const ACTIVE_MS = 60_000;

const who = (g: MapGroup) => g.agent ?? (g.process ? `${g.process} (no agent)` : "Unattributed");
const dest = (g: MapGroup) => (g.dst_host || g.dst_ip || "unknown destination") + (g.dst_port ? `:${g.dst_port}` : "");
const fmtCount = (n: number) => new Intl.NumberFormat("en", { notation: n > 9999 ? "compact" : "standard" }).format(n);

interface Place { key: string; lat: number; lon: number; city: string | null; country: string | null; groups: MapGroup[]; count: number; bytes: number; status: OutcomeGroup; last: number }

function worst(groups: MapGroup[]): OutcomeGroup {
  return groups.reduce<OutcomeGroup>((w, g) => (RANK[g.status] > RANK[w] ? g.status : w), "ok");
}

/** Static country layer; re-rendered only when the set of countries with traffic changes. */
const Countries = memo(function Countries({ active }: { active: string }) {
  const set = new Set(active.split("|"));
  return (
    <g>
      {WORLD_COUNTRIES.map(([name, d]) => (
        <path key={name} d={d} fill={set.has(name) ? "hsl(var(--primary) / 0.16)" : "hsl(var(--muted) / 0.55)"}
          stroke="hsl(var(--border))" strokeWidth={0.5} vectorEffect="non-scaling-stroke"><title>{name}</title></path>
      ))}
    </g>
  );
});

function WorldMap({ places, sites, now, selected, onSelect, activeCountries }: {
  places: Place[]; sites: TrafficMapData["sites"]; now: number; selected: string | null;
  onSelect: (key: string | null) => void; activeCountries: string;
}) {
  const [view, setView] = useState(FULL);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const k = view.w / FULL.w;

  const zoom = useCallback((factor: number, cx = 0.5, cy = 0.5) => setView(v => {
    const w = Math.min(FULL.w, Math.max(64, v.w * factor)), h = w * (FULL.h / FULL.w);
    const x = Math.min(FULL.w - w, Math.max(0, v.x + (v.w - w) * cx));
    const y = Math.min(FULL.y + FULL.h - h, Math.max(0, v.y + (v.h - h) * cy));
    return { x, y, w, h };
  }), []);
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const r = svg.current!.getBoundingClientRect();
    zoom(e.deltaY > 0 ? 1.25 : 0.8, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const r = svg.current!.getBoundingClientRect();
    const dx = (e.clientX - d.x) * (view.w / r.width), dy = (e.clientY - d.y) * (view.h / r.height);
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      if (!d.moved) svg.current!.setPointerCapture(e.pointerId);
      d.moved = true;
    }
    if (d.moved) setView(v => ({ ...v, x: Math.min(FULL.w - v.w, Math.max(0, d.vx - dx)), y: Math.min(FULL.y + FULL.h - v.h, Math.max(0, d.vy - dy)) }));
  };
  const up = () => { drag.current = null; };

  const siteList = Object.entries(sites).map(([node, s]) => ({ node, ...project(s.lat, s.lon, 2) }));
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-[hsl(222_40%_6%)]">
      <svg ref={svg} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} role="img" aria-label="World map of observed AI-layer connections"
        className="block aspect-[1024/590] w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onWheel={onWheel} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        onClick={e => { if (e.target === svg.current) onSelect(null); }}>
        <Countries active={activeCountries} />
        {places.map(p => {
          const to = project(p.lat, p.lon, 2);
          const live = now - p.last < ACTIVE_MS;
          const nodes = [...new Set(p.groups.map(g => g.node).filter((n): n is string => !!n && !!sites[n]))];
          return nodes.map(node => {
            const from = siteList.find(s => s.node === node)!;
            const lift = Math.min(120, Math.abs(to.x - from.x) / 3 + 15);
            return <path key={p.key + node} d={`M${from.x} ${from.y}Q${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - lift} ${to.x} ${to.y}`}
              fill="none" stroke={STATUS_COLOR[p.status]} strokeWidth={selected === p.key ? 2.2 : 1.2} vectorEffect="non-scaling-stroke"
              opacity={selected && selected !== p.key ? 0.15 : live ? 0.85 : 0.35} className={live ? "ai-map-flow" : undefined} />;
          });
        })}
        {siteList.map(s => (
          <g key={s.node}>
            <rect x={s.x - 4 * k} y={s.y - 4 * k} width={8 * k} height={8 * k} rx={1.5 * k} fill="hsl(var(--foreground))" />
            <title>{`${s.node} (AI node)`}</title>
          </g>
        ))}
        {places.map(p => {
          const { x, y } = project(p.lat, p.lon, 2);
          const r = (3 + Math.min(8, Math.log2(p.count + 1))) * k;
          return (
            <g key={p.key} role="button" tabIndex={0} aria-label={`${p.city ?? p.country ?? "Location"}: ${p.count} connections, ${STATUS_LABEL[p.status]}`}
              className="cursor-pointer focus:outline-none" onClick={e => { e.stopPropagation(); onSelect(p.key); }}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.key); } }}>
              <circle cx={x} cy={y} r={r * 2.2} fill={STATUS_COLOR[p.status]} opacity={0.14} />
              <circle cx={x} cy={y} r={r} fill={STATUS_COLOR[p.status]} stroke={selected === p.key ? "hsl(var(--foreground))" : "none"}
                strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <title>{`${[p.city, p.country].filter(Boolean).join(", ") || "Approximate location"} · ${p.count} connections`}</title>
            </g>
          );
        })}
      </svg>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {[["Zoom in", Plus, () => zoom(0.7)], ["Zoom out", Minus, () => zoom(1.4)], ["Reset view", RotateCcw, () => setView(FULL)]].map(([label, Icon, fn]) => {
          const I = Icon as typeof Plus;
          return <button key={label as string} type="button" aria-label={label as string} title={label as string} onClick={fn as () => void}
            className="rounded-md border border-border bg-card/90 p-1.5 text-muted-foreground hover:text-foreground"><I className="h-3.5 w-3.5" /></button>;
        })}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-card/85 px-2 py-1 text-[11px] text-muted-foreground">
        {(["ok", "failed", "blocked"] as OutcomeGroup[]).map(s => <span key={s} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />{STATUS_LABEL[s]}</span>)}
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-foreground" />AI node</span>
        <span>Locations are approximate (GeoIP)</span>
      </div>
    </div>
  );
}

/** Internal and same-host traffic as a small two-column topology: who (left) talks to which service (right). */
function InternalTopology({ groups, selected, onSelect }: { groups: MapGroup[]; selected: string | null; onSelect: (key: string) => void }) {
  const left = [...new Set(groups.map(g => `${who(g)} @ ${g.node ?? "?"}`))];
  const right = [...new Set(groups.map(g => dest(g)))];
  const row = 30, height = Math.max(left.length, right.length) * row + 10;
  if (!groups.length) return <p className="text-sm text-muted-foreground">No internal or same-host connections in this window.</p>;
  return (
    <div className="ops-scrollbar overflow-x-auto">
      <svg viewBox={`0 0 640 ${height}`} className="min-w-[540px] w-full" role="img" aria-label="Internal network connections">
        {groups.map(g => {
          const a = left.indexOf(`${who(g)} @ ${g.node ?? "?"}`) * row + 20, b = right.indexOf(dest(g)) * row + 20;
          return <path key={g.key} d={`M200 ${a}C320 ${a} 320 ${b} 440 ${b}`} fill="none" stroke={STATUS_COLOR[g.status]}
            strokeWidth={selected === g.key ? 2.5 : Math.min(4, 0.8 + Math.log10(g.count + 1))} opacity={selected && selected !== g.key ? 0.2 : 0.7}
            className="cursor-pointer" onClick={() => onSelect(g.key)}><title>{`${who(g)} → ${dest(g)} · ${g.count} connections`}</title></path>;
        })}
        {left.map((l, i) => <text key={l} x={192} y={i * row + 24} textAnchor="end" className="fill-foreground text-[11px]">{l.length > 32 ? l.slice(0, 31) + "…" : l}</text>)}
        {right.map((r, i) => {
          const g = groups.find(x => dest(x) === r)!;
          return <text key={r} x={448} y={i * row + 24} className="fill-foreground text-[11px]">{r}{g.service ? <tspan className="fill-muted-foreground"> · usually {g.service}</tspan> : null}</text>;
        })}
      </svg>
    </div>
  );
}

function GroupDetail({ group, span, onClose }: { group: MapGroup; span: string; onClose: () => void }) {
  const [events, setEvents] = useState<TrafficEvent[] | null>(null);
  const [eventId, setEventId] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const filters = { window: span, ...(group.dst_ip ? { ip: group.dst_ip } : group.dst_host ? { host: group.dst_host } : {}),
        ...(group.dst_port ? { port: String(group.dst_port) } : {}), agent: group.agent ?? "-", ...(group.process ? { process: group.process } : {}),
        status: group.status === "ok" ? "ok" : group.status, ...(group.node ? { node: group.node } : {}) };
      setEvents((await aiTraffic.events(filters, { limit: 25 })).events);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load events"); }
  }
  const field = (label: string, value: React.ReactNode) => value == null || value === "" ? null : (
    <div className="contents"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-sm">{value}</dd></div>
  );
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-medium">{dest(group)}</h3>
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1">
        {field("Agent", group.agent ?? <span className="text-muted-foreground">not identified</span>)}
        {field("Process", group.process)}
        {field("Model", group.model ? `${group.model}${group.provider ? ` (${group.provider})` : ""}` : null)}
        {field("Tool", group.mcp_tool ?? group.tool)}
        {field("Destination", group.dst_host ? `${group.dst_host} (${group.dst_ip ?? "no address"})` : group.dst_ip)}
        {field("Country", group.geo ? `${[group.geo.city, group.geo.country].filter(Boolean).join(", ")} (approximate)` : group.scope === "external" ? "Location unknown" : null)}
        {field("Network", { external: "Internet", internal: "Internal network", local: "Same host", unknown: "Unknown destination" }[group.scope])}
        {field("Protocol", (group.protocol ?? group.kind).toUpperCase())}
        {field("Port", group.dst_port ? `${group.dst_port}${group.service ? ` (usually ${group.service})` : ""}` : null)}
        {field("Direction", group.direction === "outbound" ? `Outbound from ${group.container ?? group.src_ip ?? "AI container"}` : `Inbound from ${group.src_ip ?? "?"}${group.src_count > 1 ? ` and ${group.src_count - 1} more` : ""}`)}
        {field("Status", <span className="inline-flex flex-wrap gap-1">{group.outcomes.map(o => <OutcomeBadge key={o} outcome={o} />)}</span>)}
        {field("Reason", group.reason)}
        {field("Connections", fmtCount(group.count))}
        {field("Traffic", group.unmeasured === group.count ? "not measured" : `${formatBytes(group.bytes_sent)} sent · ${formatBytes(group.bytes_recv)} received${group.unmeasured ? ` (${group.unmeasured} not measured)` : ""}`)}
        {field("Node", group.node)}
        {field("First seen", formatTimeMs(group.first_seen))}
        {field("Last seen", formatTimeMs(group.last_seen))}
      </dl>
      {events === null ? <Button size="sm" variant="outline" onClick={() => void load()}>Show individual events</Button> : (
        <ul className="max-h-60 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/60 text-xs">
          {events.length === 0 && <li className="p-2 text-muted-foreground">No events with these filters (they may have aged out).</li>}
          {events.map(e => (
            <li key={e.id}><button type="button" onClick={() => setEventId(e.id)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent">
              <span className="font-mono text-muted-foreground">{formatTimeMs(e.ts)}</span><span className="min-w-0 flex-1 truncate">{e.method ? `${e.method} ${e.path ?? ""}` : e.kind}</span><OutcomeBadge outcome={e.outcome} />
            </button></li>
          ))}
        </ul>
      )}
      {error && <ErrorNote error={error} />}
      <EventDetailDialog eventId={eventId} onClose={() => setEventId(null)} />
    </div>
  );
}

function Ranked({ title, rows }: { title: string; rows: { label: string; count: number; problems?: number }[] }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">None in this window.</p>}
      <ul className="space-y-1.5">
        {rows.slice(0, 6).map(r => (
          <li key={r.label} className="text-xs">
            <div className="flex justify-between gap-2"><span className="truncate">{r.label}</span><span className="shrink-0 tabular-nums text-muted-foreground">{fmtCount(r.count)}{r.problems ? <span className="text-status-warning"> · {fmtCount(r.problems)} problems</span> : null}</span></div>
            <div className="mt-0.5 h-1 rounded bg-secondary"><div className="h-1 rounded bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function rank(groups: MapGroup[], label: (g: MapGroup) => string) {
  const m = new Map<string, { label: string; count: number; problems: number }>();
  for (const g of groups) {
    const key = label(g), row = m.get(key) ?? { label: key, count: 0, problems: 0 };
    row.count += g.count; if (g.status !== "ok") row.problems += g.count;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** AI Traffic Monitor > Live Map: observed connections, grouped. Read-only. */
export function MapView() {
  const [span, setSpan] = useState("15m");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [text, setText] = useState({ agent: "", model: "", process: "", ip: "", host: "" });
  const [paused, setPaused] = useState(false);
  const [data, setData] = useState<TrafficMapData | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const filters = useMemo(() => ({ window: span, category, status, kind, ...Object.fromEntries(Object.entries(text).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])) }), [span, category, status, kind, text]);
  const key = JSON.stringify(filters);
  // Pause freezes the picture; a filter change while paused still loads once.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const loadedKey = useRef("");
  const error = usePoll(async () => {
    if (pausedRef.current && loadedKey.current === key) return;
    const next = await aiTraffic.map(filters);
    loadedKey.current = key;
    setData(next);
  }, 5000, [key]);

  const groups = useMemo(() => data?.groups ?? [], [data]);
  const now = data ? new Date(data.generated_at).getTime() : 0;
  const places = useMemo(() => {
    const m = new Map<string, Place>();
    for (const g of groups) {
      if (g.scope !== "external" || !g.geo) continue;
      const k = `${g.geo.lat},${g.geo.lon}`;
      const p = m.get(k) ?? { key: k, lat: g.geo.lat, lon: g.geo.lon, city: g.geo.city, country: g.geo.country, groups: [], count: 0, bytes: 0, status: "ok" as OutcomeGroup, last: 0 };
      p.groups.push(g); p.count += g.count; p.bytes += g.bytes_sent + g.bytes_recv;
      p.last = Math.max(p.last, new Date(g.last_seen).getTime());
      m.set(k, p);
    }
    for (const p of m.values()) p.status = worst(p.groups);
    return [...m.values()];
  }, [groups]);
  const activeCountries = useMemo(() => [...new Set(places.map(p => p.country && (COUNTRY_ALIAS[p.country] ?? p.country)).filter(Boolean))].sort().join("|"), [places]);
  const internal = groups.filter(g => g.scope === "internal" || g.scope === "local");
  const unlocated = groups.filter(g => g.scope === "unknown" || (g.scope === "external" && !g.geo));
  const selectedPlace = places.find(p => p.key === place) ?? null;
  const selectedGroup = groups.find(g => g.key === groupKey) ?? null;
  const missing = data?.coverage.filter(c => c.status === "missing" || c.status === "stale" || c.status === "degraded") ?? [];
  const nodesWithoutSite = [...new Set(groups.map(g => g.node).filter((n): n is string => !!n && !data?.sites[n]))];

  useAskOpsPageContext([
    { label: "Map window", value: span },
    category !== "all" && { label: "Traffic", value: category === "ai" ? "AI-attributed only" : "System only" },
    !!status && { label: "Status filter", value: status },
    selectedGroup && { label: "Selected connection", value: `${who(selectedGroup)} -> ${dest(selectedGroup)} (${selectedGroup.status}, ${selectedGroup.count} connections)` },
    selectedPlace && { label: "Selected location", value: [selectedPlace.city, selectedPlace.country].filter(Boolean).join(", ") },
  ]);

  const totals = { ext: groups.filter(g => g.scope === "external").reduce((n, g) => n + g.count, 0), int: internal.reduce((n, g) => n + g.count, 0),
    problems: groups.filter(g => g.status !== "ok").reduce((n, g) => n + g.count, 0) };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <WindowSelect value={span} onChange={setSpan} label="Window" />
        <div className="flex rounded-md border border-border p-0.5 text-xs" role="group" aria-label="Traffic type">
          {[["all", "All"], ["ai", "AI"], ["system", "System"]].map(([v, l]) => (
            <button key={v} type="button" aria-pressed={category === v} onClick={() => setCategory(v)}
              className={cn("rounded px-2.5 py-1", category === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>{l}</button>
          ))}
        </div>
        <Select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)} className="h-8 w-36 text-xs">
          <option value="">All statuses</option><option value="problem">Failed or blocked</option><option value="blocked">Blocked only</option><option value="failed">Failed only</option><option value="ok">Allowed only</option>
        </Select>
        <Select aria-label="Protocol" value={kind} onChange={e => setKind(e.target.value)} className="h-8 w-28 text-xs">
          <option value="">All protocols</option><option value="http">HTTP(S)</option><option value="tcp">TCP</option><option value="udp">UDP</option><option value="access">Refused</option>
        </Select>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setPaused(p => !p)} aria-pressed={paused}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{paused ? "Resume" : "Pause"}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {paused ? "Paused" : <><span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-ok align-middle motion-reduce:animate-none" />Live</>}
          {data && ` · ${formatTimeMs(data.generated_at)}`}
        </span>
      </div>
      <details className="rounded-md border border-border/60 px-3 py-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">More filters{Object.values(text).some(Boolean) ? " (active)" : ""}</summary>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {(["agent", "model", "process", "ip", "host"] as const).map(f => (
            <Input key={f} aria-label={f === "host" ? "Domain" : f} placeholder={f === "host" ? "Domain" : f === "ip" ? "IP address" : f[0].toUpperCase() + f.slice(1)}
              value={text[f]} onChange={e => setText(t => ({ ...t, [f]: e.target.value }))} className="h-8 text-xs" />
          ))}
        </div>
      </details>

      {error && <ErrorNote error={error} />}
      {data && !data.geoip && <p className="rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-xs">The local GeoIP database is not installed, so no destination can be placed on the map. Connections are still listed below.</p>}
      {missing.length > 0 && <p className="rounded-md border border-border bg-secondary/40 p-2 text-xs text-muted-foreground">
        Partial coverage: {missing.map(m => `${m.area}${m.node ? ` on ${m.node}` : ""}`).join("; ")}. Missing data is not evidence that no traffic happened. See Capture &amp; Sources.</p>}
      {data?.truncated && <p className="text-xs text-status-warning">Showing the {data.group_limit} most recent connection groups. Narrow the filters or window to see the rest.</p>}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md border border-border bg-card p-2"><Globe2 className="mx-auto mb-0.5 h-3.5 w-3.5 text-primary" /><span className="block text-lg font-semibold tabular-nums">{fmtCount(totals.ext)}</span>Internet</div>
            <div className="rounded-md border border-border bg-card p-2"><Network className="mx-auto mb-0.5 h-3.5 w-3.5 text-primary" /><span className="block text-lg font-semibold tabular-nums">{fmtCount(totals.int)}</span>Internal &amp; local</div>
            <div className="rounded-md border border-border bg-card p-2"><Server className="mx-auto mb-0.5 h-3.5 w-3.5 text-status-warning" /><span className={cn("block text-lg font-semibold tabular-nums", totals.problems && "text-status-warning")}>{fmtCount(totals.problems)}</span>Failed or blocked</div>
          </div>
          <WorldMap places={places} sites={data?.sites ?? {}} now={now} selected={place} activeCountries={activeCountries}
            onSelect={k => { setPlace(k); setGroupKey(null); }} />
          {nodesWithoutSite.length > 0 && <p className="text-xs text-muted-foreground">No lines are drawn from {nodesWithoutSite.join(", ")}: set its latitude and longitude under Servers to show where traffic starts.</p>}
        </div>

        <aside className="space-y-3">
          <section className="rounded-lg border border-border bg-card p-3" aria-live="polite">
            {selectedGroup ? <GroupDetail key={selectedGroup.key} group={selectedGroup} span={span} onClose={() => setGroupKey(null)} />
              : selectedPlace ? (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div><h3 className="font-medium">{[selectedPlace.city, selectedPlace.country].filter(Boolean).join(", ") || "Approximate location"}</h3>
                      <p className="text-xs text-muted-foreground">{fmtCount(selectedPlace.count)} connections · {formatBytes(selectedPlace.bytes)} · location approximate</p></div>
                    <button type="button" aria-label="Close" onClick={() => setPlace(null)} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
                  </div>
                  <ul className="divide-y divide-border/50 text-sm">
                    {selectedPlace.groups.map(g => (
                      <li key={g.key}><button type="button" onClick={() => setGroupKey(g.key)} className="flex w-full items-center gap-2 py-1.5 text-left hover:text-primary">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[g.status] }} />
                        <span className="min-w-0 flex-1"><span className="block truncate">{dest(g)}</span><span className="block truncate text-xs text-muted-foreground">{who(g)} · {(g.protocol ?? g.kind).toUpperCase()}</span></span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtCount(g.count)}</span>
                      </button></li>
                    ))}
                  </ul>
                </div>
              ) : <p className="text-sm text-muted-foreground">Select a point on the map, a line in the internal view or a row below to see who connected, where, and what happened.</p>}
          </section>
          <Ranked title="Traffic by country" rows={(data?.countries ?? []).map(c => ({ label: c.country, count: c.count, problems: c.problems }))} />
          <Ranked title="Top destinations" rows={rank(groups, dest)} />
          <Ranked title="Most active agents" rows={rank(groups.filter(g => g.category === "ai"), who)} />
        </aside>
      </div>

      <section className="space-y-2 rounded-lg border border-border bg-card p-3">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Network className="h-4 w-4 text-primary" />Internal &amp; same-host traffic <span className="text-xs font-normal text-muted-foreground">private addresses are never placed on the world map</span></h3>
        <InternalTopology groups={internal.slice(0, 60)} selected={groupKey} onSelect={k => { setGroupKey(k); setPlace(null); }} />
        {internal.length > 60 && <p className="text-xs text-muted-foreground">Showing 60 of {internal.length} groups; use the filters to narrow.</p>}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <h3 className="border-b border-border px-3 py-2 text-sm font-medium">Connections <span className="text-xs font-normal text-muted-foreground">grouped by who, destination, port, protocol and result</span></h3>
        <div className="ops-scrollbar max-h-[28rem] overflow-auto">
          <table className="ops-card-table w-full text-xs">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr>
              <th className="px-3 py-2 font-medium">Who</th><th className="px-3 py-2 font-medium">Destination</th><th className="px-3 py-2 font-medium">Where</th>
              <th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Count</th><th className="px-3 py-2 text-right font-medium">Bytes</th><th className="px-3 py-2 font-medium">Last seen</th>
            </tr></thead>
            <tbody>
              {groups.slice(0, 300).map(g => (
                <tr key={g.key} onClick={() => { setGroupKey(g.key); setPlace(null); }} className={cn("cursor-pointer border-t border-border/50 hover:bg-accent/50", groupKey === g.key && "bg-primary/10")}>
                  <td data-label="Who" className="px-3 py-1.5">{who(g)}{g.category === "system" && <Badge variant="secondary" className="ml-1">system</Badge>}</td>
                  <td data-label="Destination" className="px-3 py-1.5 font-mono">{dest(g)}</td>
                  <td data-label="Where" className="px-3 py-1.5">{g.scope === "external" ? (g.geo?.country ?? "Internet, location unknown") : { internal: "Internal", local: "Same host", unknown: "Unknown" }[g.scope]}</td>
                  <td data-label="Status" className="px-3 py-1.5"><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[g.status] }} />{STATUS_LABEL[g.status]}</span></td>
                  <td data-label="Count" className="px-3 py-1.5 text-right tabular-nums">{fmtCount(g.count)}</td>
                  <td data-label="Bytes" className="px-3 py-1.5 text-right tabular-nums">{g.unmeasured === g.count ? "—" : formatBytes(g.bytes_sent + g.bytes_recv)}</td>
                  <td data-label="Last seen" className="px-3 py-1.5 font-mono">{formatTimeMs(g.last_seen)}</td>
                </tr>
              ))}
              {data && groups.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No connections observed in this window with these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {unlocated.length > 0 && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{unlocated.length} group{unlocated.length === 1 ? "" : "s"} with an unknown destination or location are listed here but not drawn on the map.</p>}
      </section>
    </div>
  );
}
