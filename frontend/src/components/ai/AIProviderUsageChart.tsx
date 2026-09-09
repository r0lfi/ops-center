import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { api, type AIUsagePoint } from "@/lib/api";

// Categorical palette validated with the dataviz skill's checks (CVD
// separation, lightness band, contrast on this dark surface).
const PROVIDER_COLOR: Record<string, string> = {
  anthropic: "#3987e5",
  openai: "#199e70",
  ollama: "#9085e9",
};
const FALLBACK_COLOR = "#d95926";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Tokens per day, one bar per provider (grouped), from GET /api/ai/usage.
 * Cost is shown only as an estimate from list prices, and only when every
 * model in the window has a known price.
 */
export function AIProviderUsageChart() {
  const [points, setPoints] = useState<AIUsagePoint[] | null>(null);

  useEffect(() => {
    api.ai
      .usage(7)
      .then((res) => setPoints(res.points))
      .catch(() => setPoints([]));
  }, []);

  const { rows, providers, totalTokens, totalCost, costKnown } = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    const providerSet = new Map<string, string>();
    let tokens = 0;
    let cost = 0;
    let known = true;
    for (const p of points ?? []) {
      providerSet.set(p.provider_slug, p.provider_name);
      const row = byDate.get(p.date) ?? { date: p.date };
      row[p.provider_slug] = ((row[p.provider_slug] as number) ?? 0) + p.input_tokens + p.output_tokens;
      byDate.set(p.date, row);
      tokens += p.input_tokens + p.output_tokens;
      if (p.cost_usd == null) known = false;
      else cost += p.cost_usd;
    }
    return {
      rows: [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
      providers: [...providerSet.entries()],
      totalTokens: tokens,
      totalCost: cost,
      costKnown: known,
    };
  }, [points]);

  if (points === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (points.length === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm text-muted-foreground">No token usage in the last 7 days.</p>
        <p className="text-xs text-muted-foreground">Every agent run records its provider token counts here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{formatTokens(totalTokens)}</span> tokens, 7 days
        </span>
        <span>
          est. cost <span className="font-medium text-foreground">{costKnown ? `$${totalCost.toFixed(2)}` : "n/a for some models"}</span>
        </span>
      </div>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatTokens} width={40} />
            <Tooltip
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", fontSize: 12 }}
              formatter={(value: number, name: string) => [`${formatTokens(value)} tokens`, providers.find(([slug]) => slug === name)?.[1] ?? name]}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={(slug: string) => providers.find(([s]) => s === slug)?.[1] ?? slug} />
            {providers.map(([slug]) => (
              <Bar key={slug} dataKey={slug} fill={PROVIDER_COLOR[slug] ?? FALLBACK_COLOR} radius={[3, 3, 0, 0]} maxBarSize={28} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
