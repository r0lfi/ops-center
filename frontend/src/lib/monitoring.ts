import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { isUnhealthy } from "@/lib/containers";
import { formatDateTime } from "@/lib/format";


export interface NativeSeries { labels: Record<string, string>; points: [number, number][] }
export type NativeMetrics = Record<string, NativeSeries[]>;
export interface NativeAlert { name: string; severity: string; summary: string; starts_at: string }
export interface NativeHost {
  id: string; hostname: string; ip_address: string; operating_system: string | null; os_version: string | null;
  monitoring_enabled: boolean; log_collection_enabled: boolean; is_docker_host: boolean;
  container_inventory_at: string | null; status: string; last_sample: number | null;
  metrics: NativeMetrics; alerts: NativeAlert[] | null;
  services: {id: string; target: string; check_type: string; enabled: boolean}[];
}
export interface NativeContainer {
  id: string; host_id: string; hostname: string; runtime_id: string | null; name: string; image: string;
  status: string; health: string | null; restart_count: number | null; last_seen: string | null;
  metadata: { stack?: string | null; started_at?: string | null; exit_code?: number | null; memory_limit?: number | null;
    nano_cpus?: number | null; cpu_quota?: number | null; cpu_period?: number | null;
    runtime_stats?: {cpu_percent:number|null;memory_bytes:number|null;network_io:string|null;block_io:string|null;captured_at:string} | null;
    ports?: Record<string, {HostIp: string; HostPort: string}[] | null>; networks?: string[];
    mounts?: {Type: string; Source: string; Destination: string; RW: boolean}[] };
  metrics: NativeMetrics; errors?: Record<string, string>; metrics_state?: string;
}
export interface NativeFleet { hosts: NativeHost[]; containers: NativeContainer[]; errors: Record<string, string>;
  container_errors: Record<string, string>; alerts_available: boolean }
export const RANGES = [[15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "24 hours"], [10080, "7 days"]] as const;

export function useMonitoringQuery() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("minutes") ?? 60);
  const minutes = RANGES.some(([n]) => n === raw) ? raw : 60;
  const value = Number(params.get("end"));
  const end = params.has("end") && Number.isFinite(value) && value > 0 ? value : undefined;
  const update = useCallback((changes: Record<string, string | undefined>) => {
    setParams(previous => { const next = new URLSearchParams(previous); Object.entries(changes).forEach(([key, value]) => {
      if (value === undefined || value === "") next.delete(key); else next.set(key, value);
    }); return next; }, { replace: true });
  }, [setParams]);
  return {params, minutes, end, update};
}

export function useMonitoringData<T>(fetcher: () => Promise<T>, enabled = true, auto = true, interval = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const previousFetcher = useRef(fetcher);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (previousFetcher.current !== fetcher) {setData(null);setError(null);}
    previousFetcher.current = fetcher;
    async function load() {
      if (document.hidden) { if (auto) timer = setTimeout(load, interval); return; }
      setLoading(true);
      try { const result = await fetcher(); if (!stopped) { setData(result); setError(null); } }
      catch (error) { if (!stopped) setError(error instanceof Error ? error.message : "Data source unavailable"); }
      finally { if (!stopped) { setLoading(false); if (auto) timer = setTimeout(load, interval); } }
    }
    load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [fetcher, enabled, auto, interval, generation]);
  return {data, error, loading, refresh};
}

export function latest(series: NativeSeries[] | undefined): number | null {
  const p = series?.[0]?.points;
  return p?.length ? p[p.length - 1][1] : null;
}
export function totalLatest(series: NativeSeries[] | undefined): number | null {
  if (!series?.length) return null;
  return series.reduce((sum, s) => sum + (s.points.at(-1)?.[1] ?? 0), 0);
}
export function containerValue(c: NativeContainer, metric: string): number | null {
  const snapshot = (metric === "cpu" ? c.metadata.runtime_stats?.cpu_percent : metric === "memory" ? c.metadata.runtime_stats?.memory_bytes : null) ?? null;
  return c.metrics_state === "Stale" && snapshot !== null ? snapshot : latest(c.metrics[metric]) ?? snapshot;
}
export function inventoryProblem(host: NativeHost) {
  return host.is_docker_host && (!host.container_inventory_at || Date.now() - new Date(host.container_inventory_at).getTime() > 600000);
}
export function problem(c: NativeContainer): boolean {
  return c.status === "restarting" || isUnhealthy(c) || (c.status === "exited" && c.metadata.exit_code != null && c.metadata.exit_code !== 0);
}
export function stale(c: NativeContainer) { return !c.last_seen || Date.now() - new Date(c.last_seen).getTime() > 600000; }
export function percent(n: number | null) { return n === null ? "—" : `${n.toFixed(1)}%`; }
export function atTime(seconds: number | null) { return seconds === null ? "No data" : formatDateTime(seconds * 1000); }
export function duration(seconds: number | null) {
  if (seconds === null) return "Not available";
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function scopedUrl(path: string, params: URLSearchParams, changes: Record<string, string | undefined> = {}) {
  const next = new URLSearchParams(params);
  Object.entries(changes).forEach(([k, v]) => v === undefined ? next.delete(k) : next.set(k, v));
  return `${path}?${next}`;
}
