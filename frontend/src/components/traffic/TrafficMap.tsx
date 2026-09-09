import { useEffect, useRef, useState } from "react";

import { api, type TrafficDestPoint, type TrafficEvent } from "@/lib/api";
import { mapSizeForZoom, project } from "@/lib/mapProjection";

const POLL_MS = 2000;
const ARC_DURATION_MS = 1800;
const MAX_ARCS = 400;
const RECENT_LIST_SIZE = 30;
// Zoomed in further than a card-sized map would justify - this is a
// dedicated full page, so it earns a bigger/sharper grid (4x4 = 16 tiles,
// still a fixed grid that's never panned/zoomed).
const ZOOM = 2;
const MAP_SIZE = mapSizeForZoom(ZOOM);

const COLOR_OK = "52, 211, 153"; // emerald-400
const COLOR_BAD = "251, 58, 93"; // rose-500ish, brighter than the theme's --status-critical for glow contrast

interface Arc {
  event: TrafficEvent;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startedAt: number;
}

function drawArc(ctx: CanvasRenderingContext2D, arc: Arc, now: number) {
  const t = (now - arc.startedAt) / ARC_DURATION_MS;
  if (t < 0 || t > 1) return;

  const { fromX, fromY, toX, toY } = arc;
  const dist = Math.hypot(toX - fromX, toY - fromY);
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2 - Math.min(140, dist / 3.2);
  const color = arc.event.suspicious ? COLOR_BAD : COLOR_OK;

  const segments = 32;
  const upto = Math.max(1, Math.floor(segments * Math.min(t * 1.35, 1)));
  const tailStart = Math.max(0, upto - 14);

  ctx.save();
  ctx.shadowBlur = arc.event.suspicious ? 14 : 8;
  ctx.shadowColor = `rgba(${color}, 0.9)`;
  ctx.beginPath();
  for (let i = tailStart; i <= upto; i++) {
    const s = i / segments;
    const x = (1 - s) ** 2 * fromX + 2 * (1 - s) * s * midX + s ** 2 * toX;
    const y = (1 - s) ** 2 * fromY + 2 * (1 - s) * s * midY + s ** 2 * toY;
    if (i === tailStart) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgba(${color}, ${Math.max(0, 1 - t) * 0.9})`;
  ctx.lineWidth = arc.event.suspicious ? 2 : 1.4;
  ctx.lineCap = "round";
  ctx.stroke();

  const s = Math.min(t * 1.35, 1);
  const x = (1 - s) ** 2 * fromX + 2 * (1 - s) * s * midX + s ** 2 * toX;
  const y = (1 - s) ** 2 * fromY + 2 * (1 - s) * s * midY + s ** 2 * toY;
  ctx.beginPath();
  ctx.arc(x, y, arc.event.suspicious ? 3.5 : 2.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, 1 - t) * 0.95})`;
  ctx.fill();
  ctx.restore();
}

function drawSourceGlow(ctx: CanvasRenderingContext2D, arc: Arc, now: number) {
  const t = (now - arc.startedAt) / ARC_DURATION_MS;
  if (t < 0 || t > 0.4) return;
  const color = arc.event.suspicious ? COLOR_BAD : COLOR_OK;
  const alpha = (1 - t / 0.4) * 0.7;
  ctx.save();
  ctx.beginPath();
  ctx.arc(arc.fromX, arc.fromY, 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color}, ${alpha})`;
  ctx.shadowBlur = 10;
  ctx.shadowColor = `rgba(${color}, 0.9)`;
  ctx.fill();
  ctx.restore();
}

/**
 * Live traffic hitting edge-host (Caddy) and home (Nginx Proxy Manager) -
 * animated glowing arcs from each client's geolocated position, in the
 * spirit of Checkpoint's threat map. Backed by real access logs tailed
 * over SSH (backend/app/services/traffic_watch.py), not a simulation.
 * Green = normal, red = 4xx/5xx or an unusually high request rate from
 * the same IP within a 10s window.
 */
export function TrafficMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arcsRef = useRef<Arc[]>([]);
  const cursorRef = useRef(Date.now() / 1000 - 5);
  const [destinations, setDestinations] = useState<Record<string, TrafficDestPoint>>({});
  const [recent, setRecent] = useState<TrafficEvent[]>([]);
  const [stats, setStats] = useState({ total: 0, suspicious: 0, byCountry: new Map<string, number>() });
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.traffic.live(cursorRef.current);
        if (cancelled) return;
        cursorRef.current = result.now;
        setDestinations(result.destinations);
        setLive(true);

        if (result.events.length > 0) {
          const now = performance.now();
          for (const event of result.events) {
            const dest = result.destinations[event.source];
            if (event.lat == null || event.lon == null || !dest) continue;
            const from = project(event.lat, event.lon, ZOOM);
            const to = project(dest.lat, dest.lon, ZOOM);
            arcsRef.current.push({ event, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, startedAt: now });
          }
          if (arcsRef.current.length > MAX_ARCS) {
            arcsRef.current = arcsRef.current.slice(-MAX_ARCS);
          }
          setRecent((prev) => [...result.events, ...prev].slice(0, RECENT_LIST_SIZE));
          setStats((prev) => {
            const byCountry = new Map(prev.byCountry);
            for (const e of result.events) {
              if (e.country) byCountry.set(e.country, (byCountry.get(e.country) ?? 0) + 1);
            }
            return {
              total: prev.total + result.events.length,
              suspicious: prev.suspicious + result.events.filter((e) => e.suspicious).length,
              byCountry,
            };
          });
        }
      } catch {
        // ignore - transient, next poll retries
      }
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf: number;
    function frame() {
      const now = performance.now();
      ctx!.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
      arcsRef.current = arcsRef.current.filter((a) => now - a.startedAt < ARC_DURATION_MS);
      for (const arc of arcsRef.current) drawSourceGlow(ctx!, arc, now);
      for (const arc of arcsRef.current) drawArc(ctx!, arc, now);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const topCountries = [...stats.byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <div
        className="relative mx-auto shrink-0 overflow-hidden rounded-lg border border-border shadow-[0_0_40px_-10px_rgba(56,189,248,0.25)]"
        style={{ width: MAP_SIZE, height: MAP_SIZE, maxWidth: "100%", background: "radial-gradient(ellipse at center, #0c1524 0%, #050810 100%)" }}
      >
        <div
          className="absolute inset-0 grid grid-cols-4 grid-rows-4"
          style={{ filter: "invert(1) hue-rotate(180deg) brightness(0.65) saturate(0.55) contrast(1.2)" }}
        >
          {Array.from({ length: 4 }, (_, y) =>
            Array.from({ length: 4 }, (_, x) => (
              <img
                key={`${x}-${y}`}
                src={`https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`}
                alt=""
                className="h-full w-full"
                loading="lazy"
              />
            )),
          )}
        </div>

        {/* Vignette + faint scanline for a "command center" feel. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(ellipse at center, transparent 45%, rgba(2,6,12,0.75) 100%)" }}
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: "repeating-linear-gradient(0deg, #7dd3fc 0px, transparent 1px, transparent 3px)",
          }}
        />

        <canvas ref={canvasRef} width={MAP_SIZE} height={MAP_SIZE} className="absolute inset-0" />

        {Object.entries(destinations).map(([name, dest]) => {
          const { x, y } = project(dest.lat, dest.lon, ZOOM);
          return (
            <div
              key={name}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${(x / MAP_SIZE) * 100}%`, top: `${(y / MAP_SIZE) * 100}%` }}
            >
              <span className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-primary/40" />
              <span className="relative block h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_10px_2px_rgba(56,189,248,0.9)]" />
              <span className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-card/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow">
                {name}
              </span>
            </div>
          );
        })}

        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-card/80 px-2.5 py-1 text-[10px] font-medium backdrop-blur">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-status-ok" : "bg-status-unknown"}`} />
          {live ? "LIVE" : "connecting..."}
        </div>
        <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-full bg-card/80 px-2.5 py-1 text-[10px] backdrop-blur">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[rgb(52,211,153)] shadow-[0_0_6px_1px_rgba(52,211,153,0.8)]" />
            normal
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[rgb(251,58,93)] shadow-[0_0_6px_1px_rgba(251,58,93,0.8)]" />
            suspicious
          </span>
        </div>
        <p className="absolute bottom-3 right-3 text-[9px] text-muted-foreground/70">
          Map &copy; OpenStreetMap contributors
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-2xl font-bold tabular-nums">{stats.total}</div>
            <div className="text-xs text-muted-foreground">requests seen</div>
          </div>
          <div className="rounded-lg border border-status-critical/30 bg-status-critical/5 p-3">
            <div className="text-2xl font-bold tabular-nums text-status-critical">{stats.suspicious}</div>
            <div className="text-xs text-muted-foreground">flagged suspicious</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="text-2xl font-bold tabular-nums">{Object.keys(destinations).length}</div>
            <div className="text-xs text-muted-foreground">ingress points</div>
          </div>
        </div>

        {topCountries.length > 0 && (
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Top countries
            </div>
            <div className="space-y-1.5">
              {topCountries.map(([country, count]) => (
                <div key={country} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 truncate">{country}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(count / topCountries[0][1]) * 100}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card p-2">
          <div className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent requests
          </div>
          <div className="space-y-1">
            {recent.length === 0 && <p className="px-1 text-xs text-muted-foreground">Waiting for traffic...</p>}
            {recent.map((e) => (
              <div
                key={e.id}
                className={`flex items-center justify-between gap-2 rounded border-l-2 bg-secondary/40 px-2 py-1 text-xs ${
                  e.suspicious ? "border-l-status-critical" : "border-l-status-ok"
                }`}
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono font-medium">{e.ip}</span>{" "}
                  <span className="text-muted-foreground">
                    {e.city ? `${e.city}, ${e.country}` : (e.country ?? "unknown")}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {e.domain} {e.status ?? ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
