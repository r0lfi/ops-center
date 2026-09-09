import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

import { PlaybookEditorSection } from "@/components/automation/PlaybookEditorSection";
import { JobOutput } from "@/components/jobs/JobOutput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api, type Host, type HostGroup } from "@/lib/api";

const PLAYBOOK_LABELS: Record<string, string> = {
  "bootstrap.yml": "Bootstrap host",
  "gather-facts.yml": "Gather facts",
  "install-node-exporter.yml": "Install node_exporter",
  "install-alloy.yml": "Install Grafana Alloy (requires Loki - Phase 9)",
  "patch-check.yml": "Patch check",
  "patch-security.yml": "Install security patches",
  "patch-all.yml": "Install all patches",
  "reboot-check.yml": "Reboot check",
  "reboot.yml": "Reboot",
  "vulnerability-scan.yml": "Collect package inventory",
  "service-check.yml": "Service check",
  "health-check.yml": "Health check",
};

const DANGEROUS_PLAYBOOKS = new Set(["patch-security.yml", "patch-all.yml", "reboot.yml"]);

export default function Automation() {
  const [playbooks, setPlaybooks] = useState<string[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [selectedPlaybook, setSelectedPlaybook] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<"host" | "group">("host");
  const [targetId, setTargetId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.automation.playbooks().then(setPlaybooks).catch(() => setPlaybooks([]));
    api.hosts.list().then(setHosts).catch(() => setHosts([]));
    api.hostGroups.list().then(setGroups).catch(() => setGroups([]));
  }, []);

  function openRunDialog(playbook: string) {
    setSelectedPlaybook(playbook);
    setTargetType("host");
    setTargetId(hosts[0]?.id ?? "");
    setError(null);
    setConfirming(true);
  }

  async function handleRun() {
    if (!selectedPlaybook || !targetId) return;
    setError(null);
    try {
      const job = await api.automation.run({
        playbook: selectedPlaybook,
        target_type: targetType,
        ...(targetType === "host" ? { host_id: targetId } : { group_id: targetId }),
      });
      setConfirming(false);
      setActiveJobId(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start job");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Automation</h1><Button asChild variant="outline"><Link to="/automation/playbooks">Playbook Library</Link></Button></div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {playbooks.map((pb) => (
          <Card key={pb}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                {PLAYBOOK_LABELS[pb] ?? pb}
                {DANGEROUS_PLAYBOOKS.has(pb) && <Badge variant="warning">confirm</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Button size="sm" variant="outline" onClick={() => openRunDialog(pb)}>
                Run
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {confirming && selectedPlaybook && (
        <Card>
          <CardHeader>
            <CardTitle>Run {PLAYBOOK_LABELS[selectedPlaybook] ?? selectedPlaybook}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Select
                value={targetType}
                onChange={(e) => {
                  const value = e.target.value as "host" | "group";
                  setTargetType(value);
                  setTargetId(value === "host" ? (hosts[0]?.id ?? "") : (groups[0]?.id ?? ""));
                }}
                className="w-32"
              >
                <option value="host">Single host</option>
                <option value="group">Group</option>
              </Select>
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="flex-1">
                {targetType === "host"
                  ? hosts.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.hostname}
                      </option>
                    ))
                  : groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
              </Select>
            </div>
            {DANGEROUS_PLAYBOOKS.has(selectedPlaybook) && (
              <p className="text-sm text-status-warning">
                This action will modify the target host(s). Confirm before proceeding.
              </p>
            )}
            {error && <p className="text-sm text-status-critical">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={handleRun} disabled={!targetId}>
                Confirm and run
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {activeJobId && (
        <Card>
          <CardHeader>
            <CardTitle>Live output</CardTitle>
          </CardHeader>
          <CardContent>
            <JobOutput jobId={activeJobId} />
          </CardContent>
        </Card>
      )}

      <PlaybookEditorSection />
    </div>
  );
}
