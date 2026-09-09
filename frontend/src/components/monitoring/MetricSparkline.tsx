import { useMemo, useState } from "react";

const PADDING = 4;
const SIZES = {
  sm: { width: 240, height: 56, valueClass: "text-lg", boxClass: "h-14" },
  md: { width: 320, height: 80, valueClass: "text-2xl", boxClass: "h-20" },
  lg: { width: 480, height: 120, valueClass: "text-3xl", boxClass: "h-28" },
} as const;

interface Point {
  x: number;
  y: number;
  ts: number;
  value: number;
}

function statusClass(value: number, warnAt: number, criticalAt: number): string {
  if (value >= criticalAt) return "text-status-critical";
  if (value >= warnAt) return "text-status-warning";
  return "text-status-ok";
}

const defaultFormat = (v: number, unit: string) => `${v.toFixed(v < 10 && unit !== "%" ? 1 : 0)}${unit}`;

/**
 * Stat-tile contract (label + value + trend sparkline) - see the dataviz
 * skill's marks-and-anatomy.md. The line stays a single neutral hue (this
 * is one series, so no legend is needed - the title already says what's
 * plotted); only the current-value number carries the status color, same
 * convention Overview.tsx already uses for its stat tiles. Thresholds are
 * optional - metrics without a meaningful universal "too high" (network
 * throughput) just render the value in a neutral tone.
 */
export function MetricSparkline({
  label,
  points,
  unit = "%",
  warnAt,
  criticalAt,
  format,
  size = "sm",
}: {
  label: string;
  points: [number, number][];
  unit?: string;
  warnAt?: number;
  criticalAt?: number;
  format?: (value: number) => string;
  size?: "sm" | "md" | "lg";
}) {
  const [hover, setHover] = useState<Point | null>(null);
  const { width: WIDTH, height: HEIGHT, valueClass, boxClass } = SIZES[size];
  const fmt = format ?? ((v: number) => defaultFormat(v, unit));

  const { path, plotted, minV, maxV } = useMemo(() => {
    if (points.length === 0) return { path: "", plotted: [] as Point[], minV: 0, maxV: 0 };
    const values = points.map((p) => p[1]);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 1);
    const tMin = points[0][0];
    const tMax = points[points.length - 1][0];
    const tSpan = tMax - tMin || 1;
    const vSpan = maxV - minV || 1;

    const plotted = points.map(([ts, value]) => ({
      x: PADDING + ((ts - tMin) / tSpan) * (WIDTH - 2 * PADDING),
      y: HEIGHT - PADDING - ((value - minV) / vSpan) * (HEIGHT - 2 * PADDING),
      ts,
      value,
    }));
    const path = plotted.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return { path, plotted, minV, maxV };
  }, [points, WIDTH, HEIGHT]);

  const current = points.length > 0 ? points[points.length - 1][1] : null;
  const last = plotted[plotted.length - 1];
  const valueColorClass =
    current === null
      ? "text-muted-foreground"
      : warnAt !== undefined && criticalAt !== undefined
        ? statusClass(current, warnAt, criticalAt)
        : "text-foreground";

  function handleMove(evt: React.PointerEvent<SVGRectElement>) {
    if (plotted.length === 0) return;
    const rect = evt.currentTarget.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = plotted[0];
    let bestDist = Math.abs(nearest.x - px);
    for (const p of plotted) {
      const d = Math.abs(p.x - px);
      if (d < bestDist) {
        bestDist = d;
        nearest = p;
      }
    }
    setHover(nearest);
  }

  return (
    <div className="rounded-md border border-border bg-card/50 p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={`${valueClass} font-semibold tabular-nums ${valueColorClass}`}>
          {current === null ? "—" : fmt(current)}
        </span>
      </div>
      {plotted.length > 1 ? (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className={`${boxClass} w-full overflow-visible`}
          onPointerLeave={() => setHover(null)}
        >
          {/* recessive baseline */}
          <line
            x1={PADDING}
            x2={WIDTH - PADDING}
            y1={HEIGHT - PADDING}
            y2={HEIGHT - PADDING}
            className="stroke-border"
            strokeWidth={1}
          />
          <path d={path} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {last && (
            <circle cx={last.x} cy={last.y} r={4} className="fill-primary stroke-card" strokeWidth={2} />
          )}
          {hover && (
            <>
              <line
                x1={hover.x}
                x2={hover.x}
                y1={PADDING}
                y2={HEIGHT - PADDING}
                className="stroke-border"
                strokeWidth={1}
              />
              <circle cx={hover.x} cy={hover.y} r={4} className="fill-primary stroke-card" strokeWidth={2} />
            </>
          )}
          {/* full-width transparent hit area, bigger than the line itself */}
          <rect
            x={0}
            y={0}
            width={WIDTH}
            height={HEIGHT}
            fill="transparent"
            onPointerMove={handleMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      ) : (
        <div className={`${boxClass} flex items-center justify-center text-xs text-muted-foreground`}>
          no data yet
        </div>
      )}
      {hover && (
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{new Date(hover.ts * 1000).toLocaleTimeString()}</span>
          <span className="font-medium text-foreground">{fmt(hover.value)}</span>
        </div>
      )}
      {!hover && plotted.length > 1 && (
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>min {fmt(minV)}</span>
          <span>max {fmt(maxV)}</span>
        </div>
      )}
    </div>
  );
}
