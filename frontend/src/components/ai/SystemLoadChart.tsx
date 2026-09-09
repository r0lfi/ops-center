import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { api, type MetricSeries } from "@/lib/api";

// Palette validated for dark-mode categorical use (see the dataviz skill) -
// slot1 blue / slot3 aqua / slot2 orange, all pairs pass CVD + contrast.
const COLOR_CPU = "#3987e5";
const COLOR_MEMORY = "#199e70";
const COLOR_DISK = "#d95926";

interface Point {
  time: string;
  cpu: number;
  memory: number;
  disk: number;
}

function aggregate(series: MetricSeries[]): Map<number, number> {
  const byTs = new Map<number, number[]>();
  for (const s of series) {
    for (const [ts, v] of s.points) {
      const bucket = byTs.get(ts) ?? [];
      bucket.push(v);
      byTs.set(ts, bucket);
    }
  }
  const avg = new Map<number, number>();
  for (const [ts, vals] of byTs) {
    avg.set(ts, vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return avg;
}

export function SystemLoadChart() {
  const [data, setData] = useState<Point[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    api.metrics
      .hosts(1440)
      .then((res) => {
        setAvailable(res.available);
        if (!res.available) return;
        const cpu = aggregate(res.cpu);
        const memory = aggregate(res.memory);
        const disk = aggregate(res.disk);
        const timestamps = [...cpu.keys()].sort((a, b) => a - b);
        setData(
          timestamps.map((ts) => ({
            time: new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            cpu: Math.round(cpu.get(ts) ?? 0),
            memory: Math.round(memory.get(ts) ?? 0),
            disk: Math.round(disk.get(ts) ?? 0),
          })),
        );
      })
      .catch(() => setAvailable(false));
  }, []);

  if (!available) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Prometheus unavailable - no data to show.</p>;
  }
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No metrics yet.</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={190}>
      <LineChart data={data} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" />
        {/* 34px clipped the tick numbers - only the "%" suffix survived */}
        <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} unit="%" width={56} domain={[0, 100]} />
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="cpu" name="CPU" stroke={COLOR_CPU} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="memory" name="Memory" stroke={COLOR_MEMORY} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="disk" name="Disk" stroke={COLOR_DISK} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
