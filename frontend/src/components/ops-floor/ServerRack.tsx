import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Server } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, type AlertmanagerAlert, type Host } from "@/lib/api";

const OFFLINE_AFTER_MS = 30 * 60 * 1000;
const MAX_SHOWN = 9;

export type RackStatus = "ok" | "warning" | "critical" | "offline";

const DOT_COLOR: Record<RackStatus, string> = {
  ok: "bg-status-ok",
  warning: "bg-status-warning",
  critical: "bg-status-critical",
  offline: "bg-status-unknown",
};

export function statusFor(host: Host, alerts: AlertmanagerAlert[]): RackStatus {
  const staleMs = host.last_seen ? Date.now() - new Date(host.last_seen).getTime() : Infinity;
  if (staleMs > OFFLINE_AFTER_MS) return "offline";

  const active = alerts.filter(
    (a) =>
      a.status.state === "active" &&
      (a.labels.hostname === host.hostname || a.labels.instance === host.hostname),
  );
  if (active.some((a) => a.labels.severity === "critical")) return "critical";
  if (active.length > 0) return "warning";
  return "ok";
}

export function ServerRack() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.hosts.list().then(setHosts).catch(() => {});
    api.alerts
      .list()
      .then((res) => setAlerts(res.available ? res.alerts : []))
      .catch(() => {});
  }, []);

  const shown = hosts.slice(0, MAX_SHOWN);
  const overflow = hosts.length - shown.length;

  return (
    <div className="w-40 rounded-lg border border-border bg-card/90 p-2 shadow-md backdrop-blur-sm">
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Server className="h-3 w-3" />
        Server Racks
      </div>
      <div className="grid grid-cols-3 gap-1">
        {shown.map((host) => (
          <button
            key={host.id}
            title={host.hostname}
            onClick={() => navigate(`/servers/${host.id}`)}
            className="flex items-center justify-center rounded border border-border bg-secondary py-1 hover:bg-accent"
          >
            <span className={cn("h-2 w-2 rounded-full", DOT_COLOR[statusFor(host, alerts)])} />
          </button>
        ))}
        {overflow > 0 && (
          <button
            onClick={() => navigate("/servers")}
            className="flex items-center justify-center rounded border border-dashed border-border py-1 text-[10px] text-muted-foreground hover:bg-accent"
          >
            +{overflow}
          </button>
        )}
      </div>
    </div>
  );
}
