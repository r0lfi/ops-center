import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, ApiError, type LogLine, type LogsResponse } from "@/lib/api";
import { RANGES, scopedUrl, useMonitoringQuery, type NativeContainer } from "@/lib/monitoring";
import { formatDateTime } from "@/lib/format";

const MAX_LINES = 1000;
function key(line: LogLine) { return `${line.timestamp}:${JSON.stringify(line.labels)}:${line.line}`; }

export function LogViewer({hostId, containerId, containers = [], embedded = true, compact = false}: {
  hostId?: string; containerId?: string; containers?: NativeContainer[]; embedded?: boolean; compact?: boolean;
}) {
  const {params, minutes, end, update} = useMonitoringQuery();
  const selectedHost = hostId ?? params.get("host_id") ?? undefined;
  const selectedContainer = containerId ?? params.get("container_id") ?? params.get("log_container") ?? undefined;
  const legacyHost = !selectedHost ? params.get("host") ?? undefined : undefined;
  const search = params.get("log_search") ?? "";
  const service = selectedContainer ? "" : params.get("service") ?? "";
  const level = selectedContainer ? "" : params.get("level") ?? "";
  const live = (compact ? params.get("log_live") !== "0" : params.get("log_live") === "1") && end === undefined;
  const [anchor, setAnchor] = useState(() => end ?? Date.now() / 1000);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [response, setResponse] = useState<LogsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [scroll, setScroll] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const cursor = response?.next_cursor;
  const query = useCallback((stop: number, older?: string) => api.logs.query({
    host_id: selectedHost, container_id: selectedContainer, host: legacyHost, service: service || undefined,
    search, level: level || undefined, minutes, limit: compact ? 10 : 200, end: stop, cursor: older,
  }), [selectedHost, selectedContainer, legacyHost, service, search, level, minutes, compact]);
  useEffect(() => {
    const version = ++requestVersion.current;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    setLines([]); setResponse(null); setError(null);
    const fixed = end ?? Date.now() / 1000;
    setAnchor(fixed);
    async function load() {
      if (document.hidden) { if (live) timer = setTimeout(load, 10000); return; }
      setBusy(true);
      const stop = live ? Date.now() / 1000 : fixed;
      try {
        const result = await query(stop);
        if (stopped || requestVersion.current !== version) return;
        setResponse(result); setAnchor(stop); setError(null);
        setLines(previous => {
          const combined = live ? [...result.lines, ...previous] : result.lines;
          const unique = new Map(combined.map(l => [key(l), l]));
          return [...unique.values()].sort((a,b) => Number(BigInt(b.timestamp) - BigInt(a.timestamp))).slice(0, compact ? 10 : MAX_LINES);
        });
      } catch (e) {
        if (!stopped) setError(e instanceof ApiError && (e.status === 401 || e.status === 403) ? "You do not have access to these logs." : e instanceof Error ? e.message : "Log source unavailable");
      } finally { if (!stopped) {setBusy(false); if (live) timer = setTimeout(load, 10000);} }
    }
    load();
    return () => { stopped = true; clearTimeout(timer); requestVersion.current = version + 1; };
  }, [query, live, end, generation, compact]);
  useEffect(() => { if (scroll && live && box.current) box.current.scrollTop = 0; }, [lines, scroll, live]);

  async function older() {
    if (!cursor || busy || live) return;
    const version = requestVersion.current;
    setBusy(true);
    try {
      const result = await query(anchor, cursor);
      if (version !== requestVersion.current) return;
      setResponse(result);
      setLines(previous => [...new Map([...previous, ...result.lines].map(l => [key(l), l])).values()].slice(0, MAX_LINES));
    } catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : "Cannot load older logs"); }
    finally { if (version === requestVersion.current) setBusy(false); }
  }
  const logUrl = scopedUrl("/logs", params, {host:undefined, host_id:selectedHost, container_id:selectedContainer,
    log_container:undefined, end: live ? undefined : String(anchor), log_live: live ? "1" : undefined, minutes:String(minutes)});
  return <div className="flex flex-col gap-3">
    <div className={compact ? "hidden" : "flex flex-wrap items-center gap-2"}>
      <Select aria-label="Log time range" value={minutes} onChange={e => update({minutes:e.target.value})} className="w-32">{RANGES.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</Select>
      <Input aria-label="Search log messages" placeholder="Search messages…" value={search} onChange={e => update({log_search:e.target.value})} className="w-full sm:w-60"/>
      {!selectedContainer && <Input aria-label="Log service" placeholder="Service / unit" value={service} onChange={e => update({service:e.target.value})} className="w-44"/>}
      {!containerId && containers.length > 0 && <Select aria-label="Log container" value={selectedContainer ?? ""} onChange={e => update({log_container:e.target.value,container_id:undefined,service:undefined,level:undefined})} className="w-44"><option value="">Host logs</option>{containers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
      {!selectedContainer && (response?.levels?.length || level) ? <Select aria-label="Log level" value={level} onChange={e => update({level:e.target.value})} className="w-32"><option value="">All levels</option>{[...new Set([...(response?.levels ?? []), ...(level ? [level] : [])])].map(value => <option key={value} value={value}>{value}</option>)}</Select> : <span className="text-xs text-muted-foreground">Log level labels not provided</span>}
    </div>
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <BadgeText live={live} anchor={anchor}/>
      <Button size="sm" variant="outline" onClick={() => update({log_live:live ? (compact ? "0" : undefined) : "1", end:live ? String(anchor) : undefined})}>{live ? "Pause live" : "Resume live"}</Button>
      {!compact && <Button size="sm" variant="outline" disabled={busy} onClick={() => setGeneration(v => v + 1)}>Refresh logs</Button>}
      {!compact && <label className="flex items-center gap-1"><input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)}/>Wrap lines</label>}
      {!compact && <label className="flex items-center gap-1"><input type="checkbox" checked={scroll} onChange={e => setScroll(e.target.checked)}/>Auto-scroll to newest</label>}
      {embedded && <Link className="text-primary hover:underline" to={logUrl}>{compact ? "View all →" : "Open in Logs"}</Link>}
      {!compact && <span className="text-muted-foreground">{response?.source === "docker" ? "Docker log driver" : "Loki"} · newest first · up to {MAX_LINES} retained</span>}
    </div>
    {error && <p role="alert" className="text-sm text-status-warning">{error}</p>}
    {response?.state === "not_configured" && <p className="text-sm text-muted-foreground">Log collection not configured: {response.message}</p>}
    {response?.state === "unsupported" && <p className="text-sm text-muted-foreground">{response.message}</p>}
    {response?.state === "unavailable" && <p role="alert" className="text-sm text-status-warning">{response.message}</p>}
    {response?.message && response.state === "available" && <p className="text-sm text-status-warning">{response.message}</p>}
    <Card><CardContent className="p-0"><div ref={box} className={(compact ? "max-h-64 " : "h-[28rem] ") + "overflow-auto font-mono text-xs"} aria-label="Log messages">
      {busy && !response && <p className="p-4 text-muted-foreground">Loading logs…</p>}
      {!busy && response?.state === "available" && !lines.length && <p className="p-4 text-muted-foreground">{response.next_cursor ? "No matches in this page. Load older logs to search further." : "No log entries match the selected time range and filters."}</p>}
      {lines.map(line => {
        const runtimeId = line.labels.container_id?.replace(/^\/+/, "").replace(/\.scope$/, "");
        const normalizedRuntimeId = runtimeId?.replace(/^docker-/, "");
        const sourceContainer = normalizedRuntimeId && normalizedRuntimeId.length >= 12 ?
          containers.find(c => c.runtime_id?.replace(/^docker-/, "") === normalizedRuntimeId) : undefined;
        const source = line.labels.unit ?? line.labels.container_id?.slice(0,12) ?? line.labels.host ?? line.labels.job ?? "Source";
        return <div key={key(line)} className="flex items-start gap-2 border-b border-border p-2 hover:bg-accent/30">
          <div className="min-w-0 flex-1"><span className="text-muted-foreground">{formatDateTime(Number(BigInt(line.timestamp) / 1000000n))}</span>{" "}
            {sourceContainer ? <Link className="text-primary hover:underline" to={scopedUrl("/monitoring/containers/" + sourceContainer.id, params, {tab:"logs", log_live: live ? "1" : undefined})}>[{sourceContainer.name}]</Link> : <span className="text-primary">[{source}]</span>}{" "}
            <span className={wrap ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]" : "whitespace-pre"}>{line.line}</span></div>
          <Button variant="ghost" size="sm" aria-label="Copy log message" onClick={async () => {try {await navigator.clipboard.writeText(line.line);setCopied(key(line));} catch {setError("Clipboard unavailable in this browser context.");}}}>{copied === key(line) ? "Copied" : "Copy"}</Button>
        </div>;
      })}
    </div></CardContent></Card>
    {!compact && <Button variant="outline" size="sm" onClick={older} disabled={live || busy || !cursor || lines.length >= MAX_LINES}>Load older logs</Button>}
    {live && !compact && <p className="text-xs text-muted-foreground">Pause live to browse older logs. Polling stops when this view is closed or hidden.</p>}
  </div>;
}
function BadgeText({live,anchor}: {live:boolean;anchor:number}) {
  return <span className={live ? "text-primary" : "text-muted-foreground"}>{live ? "● Live · 10s polling" : `Historical · ending ${formatDateTime(anchor * 1000)}`}</span>;
}
