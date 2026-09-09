import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Card, CardContent } from "@/components/ui/card";
import { api, type Host, type MonitoringCheck } from "@/lib/api";

export default function Services() {
  const [checks, setChecks] = useState<MonitoringCheck[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);

  useEffect(() => {
    api.services.list().then(setChecks).catch(() => {});
    api.hosts.list().then(setHosts).catch(() => {});
  }, []);

  const hostById = new Map(hosts.map((h) => [h.id, h]));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Services</h1>
      <p className="text-sm text-muted-foreground">
        Systemd units explicitly opted into monitoring (set when a server is added, or via the API).
        ops-scheduler re-checks these every 2 minutes over Ansible and publishes the result as a
        Prometheus metric; the MonitoredServiceDown alert fires in Alertmanager when one goes inactive.
      </p>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Host</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No monitored services configured yet. Add them from a server's onboarding form.
                  </td>
                </tr>
              )}
              {checks.map((check) => {
                const host = hostById.get(check.host_id);
                return (
                  <tr key={check.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td className="px-4 py-3">
                      {host ? (
                        <Link to={`/servers/${host.id}`} className="text-primary hover:underline">
                          {host.hostname}
                        </Link>
                      ) : (
                        check.host_id
                      )}
                    </td>
                    <td className="px-4 py-3">{check.check_type}</td>
                    <td className="px-4 py-3 font-mono text-xs">{check.target}</td>
                    <td className="px-4 py-3">{check.enabled ? "yes" : "no"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
