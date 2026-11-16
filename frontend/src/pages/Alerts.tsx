import { Link, useSearchParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TimeAgo } from "@/components/ui/time-ago";
import { api, type AlertmanagerAlert } from "@/lib/api";
import { severityVariant } from "@/lib/severity";

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const rank = (alert: AlertmanagerAlert) => SEVERITY_RANK[alert.labels.severity] ?? 3;
const hostOf = (alert: AlertmanagerAlert) => alert.labels.hostname ?? alert.labels.instance ?? "";

/** Worst first, and the newest within the same severity. */
function bySeverityThenTime(a: AlertmanagerAlert, b: AlertmanagerAlert) {
  return rank(a) - rank(b) || new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime();
}

function AlertRow({ alert }: { alert: AlertmanagerAlert }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-accent/50">
      <td data-label="Alert" className="px-4 py-3 font-medium">{alert.labels.alertname}</td>
      <td data-label="Severity" className="px-4 py-3"><Badge variant={severityVariant(alert.labels.severity)}>{alert.labels.severity ?? "unknown"}</Badge></td>
      <td data-label="Host" className="px-4 py-3">{hostOf(alert) || "-"}</td>
      <td data-label="Summary" className="px-4 py-3 text-muted-foreground">{alert.annotations.summary}</td>
      <td data-label="Since" className="whitespace-nowrap px-4 py-3 text-muted-foreground"><TimeAgo value={alert.startsAt} /></td>
    </tr>
  );
}

const rowKey = (alert: AlertmanagerAlert) => `${alert.startsAt}/${JSON.stringify(alert.labels)}`;

export default function Alerts() {
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const [params, setParams] = useSearchParams();
  const hostFilter = params.get("host") ?? "";
  const alertFilter = params.get("alert") ?? "";
  const severity = params.get("severity") ?? "";
  const grouped = params.get("group") === "host";
  const [search, setSearch] = useState("");
  const [available, setAvailable] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    function refresh() {
      api.alerts
        .list()
        .then((res) => {
          setAvailable(res.available);
          setAlerts(res.alerts);
        })
        .catch(() => setAvailable(false))
        .finally(() => setLoaded(true));
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  const firing = useMemo(() => alerts.filter((a) => a.status.state === "active"), [alerts]);
  const visible = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return firing
      .filter((a) => !hostFilter || hostOf(a) === hostFilter)
      .filter((a) => !alertFilter || a.labels.alertname === alertFilter)
      .filter((a) => !severity || (severity === "other" ? a.labels.severity !== "critical" : a.labels.severity === severity))
      .filter((a) => {
        const text = `${a.labels.alertname} ${hostOf(a)} ${a.annotations.summary ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort(bySeverityThenTime);
  }, [firing, hostFilter, alertFilter, severity, search]);

  // The list is sorted, so a host's first appearance puts the worst host first.
  const hosts = useMemo(() => {
    const byHost = new Map<string, AlertmanagerAlert[]>();
    for (const alert of visible) byHost.set(hostOf(alert), [...(byHost.get(hostOf(alert)) ?? []), alert]);
    return [...byHost];
  }, [visible]);

  return (
    <div className="space-y-4">
      <PageHeader title="Alerts" description={<>Track handling and complete incidents in <Link to="/incidents" className="text-primary underline">Incidents</Link>. This page shows the underlying monitoring signals.</>} />
      {(hostFilter || alertFilter) && <p className="text-xs text-muted-foreground">Filtered to {hostFilter && <span className="font-mono text-foreground">{hostFilter}</span>}{hostFilter && alertFilter ? " · " : ""}{alertFilter && <span className="text-foreground">{alertFilter}</span>} · <Link to="/alerts" className="text-primary hover:underline">Clear filter</Link></p>}

      {!available && (
        <p className="text-sm text-status-warning">
          Alertmanager is unavailable right now - alert data cannot be shown.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">Search<Input aria-label="Search alerts" placeholder="Alert, host or summary…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label className="min-w-40 space-y-1 text-xs text-muted-foreground">Severity
          <Select aria-label="Severity" value={severity} onChange={(e) => setFilter("severity", e.target.value)}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="other">Everything but critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </Select>
        </label>
        <Button variant={grouped ? "default" : "outline"} aria-pressed={grouped} onClick={() => setFilter("group", grouped ? "" : "host")}>Group by host</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="ops-card-table w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Alert</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Host</th>
                  <th className="px-4 py-3 font-medium">Summary</th>
                  <th className="px-4 py-3 font-medium">Since</th>
                </tr>
              </thead>
              {available && loaded && visible.length === 0 && (
                <tbody>
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {firing.length ? "No alerts match these filters." : "No active alerts."}
                    </td>
                  </tr>
                </tbody>
              )}
              {grouped ? hosts.map(([host, rows]) => (
                <tbody key={host}>
                  <tr className="border-b border-border bg-muted/40">
                    <th colSpan={5} scope="rowgroup" className="px-4 py-2 text-left text-xs font-semibold">{host || "No host"} · {rows.length}</th>
                  </tr>
                  {rows.map((alert) => <AlertRow key={rowKey(alert)} alert={alert} />)}
                </tbody>
              )) : (
                <tbody>
                  {visible.map((alert) => <AlertRow key={rowKey(alert)} alert={alert} />)}
                </tbody>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
