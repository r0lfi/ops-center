import { useEffect, useState } from "react";

import { AdvisoryDetailDialog } from "@/components/security/AdvisoryDetailDialog";
import { VulnerabilityDetailDialog } from "@/components/security/VulnerabilityDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type SecurityAdvisory, type SecuritySummary, type Vulnerability } from "@/lib/api";

const PRIORITY_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  emergency: "critical",
  critical: "critical",
  high: "warning",
  medium: "warning",
  low: "ok",
};

const SOURCE_LABELS: Record<string, string> = {
  cisa_kev: "CISA KEV",
  first_epss: "FIRST EPSS",
  almalinux_errata: "AlmaLinux Errata",
};

function SourceStatusRow({ name, status, lastSuccess, error }: { name: string; status: string; lastSuccess: string | null; error: string | null }) {
  const ok = status === "ok";
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-status-ok" : status === "never_run" ? "bg-status-unknown" : "bg-status-critical"}`} />
        {SOURCE_LABELS[name] ?? name}
      </div>
      <span className="text-xs text-muted-foreground">
        {lastSuccess ? `updated ${new Date(lastSuccess).toLocaleString()}` : "never updated"}
        {error && ` - ${error.slice(0, 80)}`}
      </span>
    </div>
  );
}

export default function SecurityIntelligence() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [attention, setAttention] = useState<Vulnerability[]>([]);
  const [advisories, setAdvisories] = useState<SecurityAdvisory[]>([]);
  const [selected, setSelected] = useState<Vulnerability | null>(null);
  const [selectedAdvisory, setSelectedAdvisory] = useState<SecurityAdvisory | null>(null);
  const [showAllAdvisories, setShowAllAdvisories] = useState(false);

  useEffect(() => {
    function refresh() {
      api.security.summary().then(setSummary).catch(() => {});
      api.security.attention(15).then(setAttention).catch(() => {});
      api.security.advisories({ affectedOnly: !showAllAdvisories }).then(setAdvisories).catch(() => {});
    }
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [showAllAdvisories]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Security Intelligence</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>New critical advisories</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-critical">
              {summary?.new_critical_advisories ?? "-"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>New KEV entries</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-critical">{summary?.new_kev_entries ?? "-"}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Affected systems</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold">
              {summary ? summary.affected_hosts + summary.affected_containers : "-"}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Fixes available</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-semibold text-status-ok">{summary?.fix_available ?? "-"}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Feed sources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(summary?.sources ?? []).map((s) => (
            <SourceStatusRow key={s.name} name={s.name} status={s.status} lastSuccess={s.last_success_at} error={s.last_error} />
          ))}
          {(!summary || summary.sources.length === 0) && (
            <p className="text-sm text-muted-foreground">No feed runs recorded yet.</p>
          )}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          What Needs Attention
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Ranked by a priority score (severity, CVSS, CISA KEV, EPSS, fix availability, affected host
          criticality, and how many hosts/containers are affected) - not just sorted by publish date.
        </p>
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Priority</th>
                  <th className="px-4 py-3 font-medium">CVE</th>
                  <th className="px-4 py-3 font-medium">Package</th>
                  <th className="px-4 py-3 font-medium">KEV</th>
                  <th className="px-4 py-3 font-medium">EPSS</th>
                  <th className="px-4 py-3 font-medium">Fixed version</th>
                  <th className="px-4 py-3 font-medium">Affected</th>
                </tr>
              </thead>
              <tbody>
                {attention.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      Nothing needs attention right now.
                    </td>
                  </tr>
                )}
                {attention.map((v) => (
                  <tr
                    key={v.id}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                    onClick={() => setSelected(v)}
                  >
                    <td className="px-4 py-3">
                      <Badge variant={PRIORITY_VARIANT[v.priority_level] ?? "unknown"}>{v.priority_level}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-primary hover:underline">{v.cve_id}</td>
                    <td className="px-4 py-3 font-mono text-xs">{v.package_name}</td>
                    <td className="px-4 py-3">{v.cisa_kev && <Badge variant="critical">KEV</Badge>}</td>
                    <td className="px-4 py-3">{v.epss_score !== null ? v.epss_score.toFixed(3) : "-"}</td>
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
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Advisory Feed</h2>
            <p className="text-xs text-muted-foreground">
              {showAllAdvisories
                ? "Every AlmaLinux advisory fetched, including ones for packages nothing here runs."
                : "Only advisories affecting a host in this fleet - sorted by how many hosts they hit."}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowAllAdvisories((v) => !v)}>
            {showAllAdvisories ? "Show only affecting my fleet" : "Show all advisories"}
          </Button>
        </div>
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Advisory</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">CVEs</th>
                  <th className="px-4 py-3 font-medium">Package</th>
                  <th className="px-4 py-3 font-medium">Affected hosts</th>
                </tr>
              </thead>
              <tbody>
                {advisories.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      {showAllAdvisories
                        ? "No advisories fetched yet - the feed runs hourly."
                        : "Nothing in the feed currently affects a host in this fleet."}
                    </td>
                  </tr>
                )}
                {advisories.slice(0, 100).map((a) => (
                  <tr
                    key={a.id}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                    onClick={() => setSelectedAdvisory(a)}
                  >
                    <td className="px-4 py-3 text-muted-foreground">
                      {a.published_at ? new Date(a.published_at).toLocaleDateString() : "-"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-primary hover:underline">{a.advisory_id}</td>
                    <td className="px-4 py-3">
                      <Badge variant={PRIORITY_VARIANT[a.severity] ?? "unknown"}>{a.severity}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{a.cve_ids.slice(0, 3).join(", ")}</td>
                    <td className="px-4 py-3 font-mono text-xs">{a.packages.slice(0, 2).join(", ")}</td>
                    <td className="px-4 py-3">
                      {a.affected_hosts.length > 0 ? (
                        <Badge variant="warning">{a.affected_hosts.length}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      </section>

      {selected && <VulnerabilityDetailDialog vuln={selected} onClose={() => setSelected(null)} />}
      {selectedAdvisory && (
        <AdvisoryDetailDialog advisory={selectedAdvisory} onClose={() => setSelectedAdvisory(null)} />
      )}
    </div>
  );
}
