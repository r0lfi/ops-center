import { useEffect, useState } from "react";

import { VulnerabilityDetailDialog } from "@/components/security/VulnerabilityDetailDialog";
import { ContainerFixButton } from "@/components/security/ContainerFixButton";
import { HostPatchActions } from "@/components/security/HostPatchActions";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type ContainerInfo, type Host, type SecuritySummary, type Vulnerability } from "@/lib/api";

const SEVERITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  critical: "critical",
  high: "critical",
  medium: "warning",
  low: "ok",
  unknown: "unknown",
};

export default function Vulnerabilities() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [vulns, setVulns] = useState<Vulnerability[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [severity, setSeverity] = useState("");
  const [kevOnly, setKevOnly] = useState(false);
  const [tab, setTab] = useState<"servers" | "containers">("servers");
  const [hostId, setHostId] = useState<string | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Vulnerability | null>(null);

  useEffect(() => {
    api.hosts.list().then(setHosts).catch(() => {});
    api.containers.list().then(setContainers).catch(() => {});
  }, []);

  const selectedHost = hosts.find((h) => h.id === hostId) ?? null;
  const selectedContainer = containers.find((c) => c.id === containerId) ?? null;

  function refresh() {
    api.security.summary().then(setSummary).catch(() => {});
    api.security
      .vulnerabilities({
        severity: severity || undefined,
        kev_only: kevOnly || undefined,
        host_id: tab === "servers" && hostId ? hostId : undefined,
        container_name: tab === "containers" && selectedContainer ? selectedContainer.name : undefined,
      })
      .then(setVulns)
      .catch(() => {});
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, kevOnly, tab, hostId, containerId]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Vulnerabilities</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {summary && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Total</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold">{summary.total_vulnerabilities}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Critical</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold text-status-critical">{summary.critical}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>High</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold text-status-critical">{summary.high}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>CISA KEV</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold text-status-critical">{summary.kev}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Fix available</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold text-status-ok">{summary.fix_available}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Affected hosts</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold">{summary.affected_hosts}</span>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Affected containers</CardTitle>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold">{summary.affected_containers}</span>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "servers" | "containers")}>
        <TabsList>
          <TabsTrigger value="servers">Search a server</TabsTrigger>
          <TabsTrigger value="containers">Search a container</TabsTrigger>
        </TabsList>

        <TabsContent value="servers">
          <div className="flex flex-wrap items-center gap-2">
            <SearchCombobox
              items={hosts.map((h) => ({ id: h.id, label: h.hostname, sublabel: h.ip_address }))}
              selectedId={hostId}
              onSelect={setHostId}
              placeholder="Search servers by hostname..."
            />
            {selectedHost && vulns.some((v) => v.fix_available) && (
              <HostPatchActions hostId={selectedHost.id} hostname={selectedHost.hostname} />
            )}
          </div>
          {selectedHost && vulns.length === 0 && (
            <p className="mt-2 text-sm text-status-ok">
              {selectedHost.hostname} has no recorded vulnerabilities right now - it doesn't need any patching for
              this.
            </p>
          )}
        </TabsContent>

        <TabsContent value="containers">
          <div className="flex flex-wrap items-center gap-2">
            <SearchCombobox
              items={containers.map((c) => ({
                id: c.id,
                label: c.name,
                sublabel: `${c.hostname} · ${c.vulnerability_count} CVE${c.vulnerability_count === 1 ? "" : "s"}`,
              }))}
              selectedId={containerId}
              onSelect={setContainerId}
              placeholder="Search containers by name..."
            />
            {selectedContainer && <ContainerFixButton hostname={selectedContainer.hostname} image={selectedContainer.image} />}
          </div>
          {selectedContainer && vulns.length === 0 && (
            <p className="mt-2 text-sm text-status-ok">
              {selectedContainer.name} has no recorded vulnerabilities right now - a newer image isn't needed for
              this.
            </p>
          )}
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2">
        <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-40">
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
        <Button variant={kevOnly ? "default" : "outline"} size="sm" onClick={() => setKevOnly((v) => !v)}>
          KEV only
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">CVE</th>
                <th className="px-4 py-3 font-medium">Package</th>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">CVSS</th>
                <th className="px-4 py-3 font-medium">KEV</th>
                <th className="px-4 py-3 font-medium">Fixed version</th>
                <th className="px-4 py-3 font-medium">Affected</th>
              </tr>
            </thead>
            <tbody>
              {vulns.length === 0 && !selectedHost && !selectedContainer && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No vulnerabilities recorded yet. Run a scan from a server's detail page.
                  </td>
                </tr>
              )}
              {vulns.map((v) => (
                <tr
                  key={v.id}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                  onClick={() => setSelected(v)}
                >
                  <td className="px-4 py-3 font-mono text-xs text-primary hover:underline">{v.cve_id}</td>
                  <td className="px-4 py-3 font-mono text-xs">{v.package_name}</td>
                  <td className="px-4 py-3">
                    <Badge variant={SEVERITY_VARIANT[v.severity] ?? "unknown"}>{v.severity}</Badge>
                  </td>
                  <td className="px-4 py-3">{v.cvss_score ?? "-"}</td>
                  <td className="px-4 py-3">{v.cisa_kev && <Badge variant="critical">KEV</Badge>}</td>
                  <td className="px-4 py-3 font-mono text-xs">{v.fixed_version ?? "-"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {[...v.affected_hosts.map((h) => h.hostname), ...v.affected_containers.map((c) => c.name)].join(
                      ", ",
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

      {selected && <VulnerabilityDetailDialog vuln={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
