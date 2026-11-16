import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatNumber, formatRelativeTime } from "@/lib/format";
import { aiTraffic, type FlowLink } from "@/lib/aiTraffic";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { ErrorNote, WindowSelect, usePoll } from "./common";

const MAX_DESTINATIONS = 24;
const ROW = 30;
const COL_X = [8, 330, 652];
const NODE_W = 240;
const WIDTH = COL_X[2] + NODE_W + 8;

interface Node { id: string; col: 0 | 1 | 2; label: string; n: number; problems: number; blocked: number; y: number; kind: string }
interface Edge { id: string; from: string; to: string; n: number; problems: number; blocked: number; bytes: number; links: FlowLink[] }

function viaLabel(via: string | null): { id: string; label: string; kind: string } {
  if (!via) return { id: "via:direct", label: "direct (no tool/model)", kind: "direct" };
  const [kind, ...rest] = via.split(":");
  return { id: `via:${via}`, label: `${kind === "mcp" ? "MCP " : kind === "model" ? "model " : ""}${rest.join(":")}`, kind };
}

function build(links: FlowLink[]) {
  const destTotals = new Map<string, number>();
  for (const l of links) destTotals.set(l.destination, (destTotals.get(l.destination) ?? 0) + l.n);
  const keep = new Set([...destTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DESTINATIONS).map(([d]) => d));
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const touch = (id: string, col: Node["col"], label: string, kind: string, l: FlowLink) => {
    const node = nodes.get(id) ?? { id, col, label, n: 0, problems: 0, blocked: 0, y: 0, kind };
    node.n += l.n; node.problems += l.problems; node.blocked += l.blocked;
    nodes.set(id, node);
  };
  const link = (from: string, to: string, l: FlowLink) => {
    const id = `${from}→${to}`;
    const e = edges.get(id) ?? { id, from, to, n: 0, problems: 0, blocked: 0, bytes: 0, links: [] };
    e.n += l.n; e.problems += l.problems; e.blocked += l.blocked; e.bytes += l.bytes; e.links.push(l);
    edges.set(id, e);
  };
  for (const l of links) {
    const origin = `origin:${l.origin}`;
    const via = viaLabel(l.via);
    const dest = keep.has(l.destination) ? `dest:${l.destination}` : "dest:other";
    touch(origin, 0, l.is_agent ? l.origin : `${l.origin} (no agent)`, l.is_agent ? "agent" : "process", l);
    touch(via.id, 1, via.label, via.kind, l);
    touch(dest, 2, dest === "dest:other" ? `other destinations (${destTotals.size - keep.size})` : l.destination, "destination", l);
    link(origin, via.id, l);
    link(via.id, dest, l);
  }
  const cols: Node[][] = [[], [], []];
  for (const n of nodes.values()) cols[n.col].push(n);
  for (const col of cols) col.sort((a, b) => b.n - a.n).forEach((n, i) => { n.y = 24 + i * ROW; });
  const height = 24 + Math.max(...cols.map(c => c.length), 1) * ROW;
  return { nodes, edges: [...edges.values()], height };
}

function tone(x: { problems: number; blocked: number }) {
  return x.blocked > 0 ? "critical" : x.problems > 0 ? "warning" : "ok";
}
const STROKE = { ok: "hsl(var(--primary))", warning: "hsl(var(--status-warning))", critical: "hsl(var(--status-critical))" };

export function FlowView() {
  const { hasRole } = useAuth();
  const [window, setWindow] = useState("1h");
  const [links, setLinks] = useState<FlowLink[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const error = usePoll(async () => { if (hasRole("operator")) setLinks((await aiTraffic.flow(window)).links); }, 15000, [window]);
  const graph = useMemo(() => build(links ?? []), [links]);
  const maxN = Math.max(1, ...graph.edges.map(e => e.n));
  const active = hover ?? selected;
  const edge = graph.edges.find(e => e.id === selected) ?? null;
  const touches = (e: Edge, id: string | null) => !id || e.id === id || e.from === id || e.to === id;
  if (!hasRole("operator")) return <p className="text-sm text-muted-foreground">The flow graph needs the operator role.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WindowSelect value={window} onChange={setWindow} />
        <p className="text-xs text-muted-foreground">Line width = connections · <span className="text-status-warning">amber</span> = failures · <span className="text-status-critical">red</span> = observed blocks. Select a line or box.</p>
      </div>
      <ErrorNote error={error} />
      <Card>
        <CardContent className="p-2">
          {!links ? <p className="p-2 text-sm text-muted-foreground">Loading…</p> : links.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No AI network activity in this window.</p> : (
            <div className="overflow-x-auto">
              <svg viewBox={`0 0 ${WIDTH} ${graph.height}`} width={WIDTH} height={graph.height} className="max-w-none" role="img" aria-label="Flow from agents through tools and models to destinations">
                {["Agent / process", "Tool / model", "Destination"].map((h, i) => (
                  <text key={h} x={COL_X[i]} y={12} fill="hsl(var(--muted-foreground))" fontSize={11}>{h}</text>
                ))}
                {graph.edges.map(e => {
                  const a = graph.nodes.get(e.from)!, b = graph.nodes.get(e.to)!;
                  const x1 = COL_X[a.col] + NODE_W, y1 = a.y + 11, x2 = COL_X[b.col], y2 = b.y + 11, mx = (x1 + x2) / 2;
                  const width = 1.5 + 6 * Math.sqrt(e.n / maxN);
                  const on = touches(e, active);
                  return (
                    <g key={e.id}>
                      <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={STROKE[tone(e)]} strokeWidth={width}
                        strokeOpacity={on ? (e.id === selected ? 0.95 : 0.55) : 0.08} />
                      <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="transparent" strokeWidth={Math.max(12, width + 6)}
                        className="cursor-pointer" onMouseEnter={() => setHover(e.id)} onMouseLeave={() => setHover(null)} onClick={() => setSelected(e.id === selected ? null : e.id)}>
                        <title>{`${a.label} → ${b.label}: ${e.n} connections, ${e.problems} not OK`}</title>
                      </path>
                    </g>
                  );
                })}
                {[...graph.nodes.values()].map(n => {
                  const t = tone(n);
                  const on = !active || active === n.id || graph.edges.some(e => (e.id === active || active === n.id) && (e.from === n.id || e.to === n.id));
                  return (
                    <g key={n.id} transform={`translate(${COL_X[n.col]},${n.y})`} className="cursor-pointer" opacity={on ? 1 : 0.35}
                      onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => setSelected(n.id === selected ? null : n.id)}>
                      <rect width={NODE_W} height={22} rx={4} fill="hsl(var(--secondary))" stroke={t === "ok" ? "hsl(var(--border))" : STROKE[t]} strokeWidth={selected === n.id ? 2 : 1} />
                      <text x={8} y={15} fill="hsl(var(--foreground))" fontSize={11} fontFamily="ui-monospace, monospace">
                        {n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label}
                      </text>
                      <text x={NODE_W - 6} y={15} fill="hsl(var(--muted-foreground))" fontSize={10} textAnchor="end">{formatNumber(n.n)}</text>
                      <title>{`${n.label}: ${n.n} connections, ${n.problems} not OK, ${n.blocked} blocked`}</title>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </CardContent>
      </Card>
      {edge && (
        <Card>
          <CardHeader><CardTitle className="break-all">{graph.nodes.get(edge.from)?.label} → {graph.nodes.get(edge.to)?.label}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{formatNumber(edge.n)} connections · {formatNumber(edge.problems)} not OK · {formatNumber(edge.blocked)} blocked · {formatBytes(edge.bytes)}</p>
            <ul className="space-y-1 text-xs">
              {edge.links.slice(0, 20).map((l, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2 rounded bg-secondary/60 p-1.5">
                  <span className="font-mono">{l.origin} · {l.via ?? "direct"} → {l.destination}</span>
                  <span className="flex gap-3">
                    <span>{l.n}× · last {formatRelativeTime(l.last_seen)}</span>
                    <Link className="text-primary hover:underline" to={`/ai-traffic/live?window=${window}&host=${encodeURIComponent(l.destination.replace(/:\d+$/, ""))}${l.is_agent ? `&agent=${encodeURIComponent(l.origin)}` : ""}`}>events</Link>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {links && links.length > 0 && (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">Table view</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead><tr className="text-left text-muted-foreground">{["Origin", "Via", "Destination", "Connections", "Not OK", "Blocked", "Data"].map(h => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {links.map((l, i) => (
                  <tr key={i} className={cn("border-t border-border/60", l.blocked ? "text-status-critical" : l.problems ? "text-status-warning" : "")}>
                    <td className="px-2 py-1">{l.origin}</td><td className="px-2 py-1">{l.via ?? "direct"}</td><td className="px-2 py-1 font-mono">{l.destination}</td>
                    <td className="px-2 py-1 tabular-nums">{l.n}</td><td className="px-2 py-1 tabular-nums">{l.problems}</td><td className="px-2 py-1 tabular-nums">{l.blocked}</td>
                    <td className="px-2 py-1">{formatBytes(l.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
