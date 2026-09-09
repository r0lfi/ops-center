import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";

interface StreamLine {
  sequence?: number;
  event_type: string;
  host?: string | null;
  task?: string | null;
  message?: string | null;
  status?: string;
}

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  successful: "ok",
  running: "warning",
  queued: "unknown",
  failed: "critical",
  cancelled: "unknown",
};

function lineClass(event: StreamLine): string {
  if (event.event_type === "runner_on_failed" || event.event_type === "runner_on_unreachable") {
    return "text-status-critical";
  }
  if (event.event_type === "runner_on_ok" && event.message) {
    return "text-status-ok";
  }
  return "text-muted-foreground";
}

export function JobOutput({ jobId }: { jobId: string }) {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [status, setStatus] = useState<string>("running");
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setConnection("connecting");
    const source = new EventSource(`/api/jobs/${jobId}/stream`);

    source.onopen = () => setConnection("connected");

    source.onmessage = (ev) => {
      try {
        const data: StreamLine = JSON.parse(ev.data);
        if (data.event_type === "job_complete") {
          setStatus(data.status ?? "successful");
          source.close();
          return;
        }
        if (data.event_type === "stream_timeout") {
          source.close();
          return;
        }
        setLines((prev) => [...prev, data]);
      } catch {
        // ignore malformed keepalive/comment lines
      }
    };

    source.onerror = () => {
      // EventSource retries on its own (default ~3s) unless we close it -
      // closing unconditionally here (the previous behavior) silently
      // killed the stream on any blip (server restart, network hiccup)
      // and left the status badge stuck on "running" forever with no
      // sign anything was wrong. So: let the browser retry, and only
      // surface "reconnecting" state - readyState CLOSED means the
      // browser itself gave up (or we closed it ourselves above on
      // job_complete/stream_timeout), nothing to show for that case.
      if (source.readyState !== EventSource.CLOSED) {
        setConnection("reconnecting");
      }
    };

    return () => source.close();
  }, [jobId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Status:</span>
        <Badge variant={STATUS_VARIANT[status] ?? "unknown"}>{status}</Badge>
        {connection === "reconnecting" && (
          <span className="text-xs text-status-warning">Reconnecting to live output...</span>
        )}
      </div>
      <div
        ref={scrollRef}
        className="max-h-96 overflow-y-auto rounded-md border border-border bg-background p-3 font-mono text-xs"
      >
        {lines.length === 0 && <p className="text-muted-foreground">Waiting for output...</p>}
        {lines.map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line.host && <span className="text-primary">[{line.host}] </span>}
            {line.task && <span className="text-foreground">{line.task}: </span>}
            {line.message || line.event_type}
          </div>
        ))}
      </div>
    </div>
  );
}
