import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api, type LogLine } from "@/lib/api";

const TIME_RANGES = [
  { label: "Last 15 min", minutes: 15 },
  { label: "Last hour", minutes: 60 },
  { label: "Last 6 hours", minutes: 360 },
  { label: "Last 24 hours", minutes: 1440 },
];

export default function Logs() {
  const [searchParams] = useSearchParams();
  const [host, setHost] = useState(searchParams.get("host") ?? "");
  const [service, setService] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    function refresh() {
      api.logs
        .query({ host: host || undefined, service: service || undefined, minutes })
        .then((res) => {
          setAvailable(res.available);
          setLines(res.lines);
        })
        .catch(() => setAvailable(false));
    }
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, service, minutes]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Logs</h1>
      <p className="text-sm text-muted-foreground">
        systemd journal, syslog, and auth logs shipped by Grafana Alloy from hosts with monitoring
        enabled, via Loki.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="log-host">Host</Label>
          <Input id="log-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="example-dns-02" className="w-48" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="log-service">Service / unit</Label>
          <Input
            id="log-service"
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="sshd.service"
            className="w-48"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="log-range">Time range</Label>
          <Select id="log-range" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-40">
            {TIME_RANGES.map((r) => (
              <option key={r.minutes} value={r.minutes}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!available && (
        <p className="text-sm text-status-warning">Loki is unavailable right now - logs cannot be shown.</p>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[32rem] overflow-y-auto font-mono text-xs">
            {available && lines.length === 0 && (
              <p className="p-4 text-muted-foreground">No log lines match these filters.</p>
            )}
            {lines.map((l, i) => (
              <div key={i} className="border-b border-border px-4 py-1.5 last:border-0 hover:bg-accent/30">
                <span className="text-muted-foreground">
                  {new Date(Number(l.timestamp) / 1_000_000).toLocaleTimeString()}
                </span>{" "}
                <span className="text-primary">[{l.labels.host ?? l.labels.job ?? "?"}]</span>{" "}
                {l.line}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
