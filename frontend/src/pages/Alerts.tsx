import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api, type AlertmanagerAlert } from "@/lib/api";

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  critical: "critical",
  warning: "warning",
};

export default function Alerts() {
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    function refresh() {
      api.alerts
        .list()
        .then((res) => {
          setAvailable(res.available);
          setAlerts(res.alerts);
        })
        .catch(() => setAvailable(false));
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  const active = alerts.filter((a) => a.status.state === "active");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Alerts</h1>

      {!available && (
        <p className="text-sm text-status-warning">
          Alertmanager is unavailable right now - alert data cannot be shown.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Alert</th>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">Host</th>
                <th className="px-4 py-3 font-medium">Summary</th>
                <th className="px-4 py-3 font-medium">Since</th>
              </tr>
            </thead>
            <tbody>
              {available && active.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No active alerts.
                  </td>
                </tr>
              )}
              {active.map((alert, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3 font-medium">{alert.labels.alertname}</td>
                  <td className="px-4 py-3">
                    <Badge variant={SEVERITY_VARIANT[alert.labels.severity] ?? "unknown"}>
                      {alert.labels.severity ?? "unknown"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">{alert.labels.hostname ?? alert.labels.instance ?? "-"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{alert.annotations.summary}</td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(alert.startsAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
