import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
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
  "install-alloy.yml": "Install Grafana Alloy",
  "patch-check.yml": "Check for patches",
  "patch-security.yml": "Install security patches",
  "patch-all.yml": "Install all patches",
  "reboot-check.yml": "Check if a reboot is needed",
  "reboot.yml": "Reboot",
  "vulnerability-scan.yml": "Collect package inventory",
  "service-check.yml": "Check services",
  "health-check.yml": "Check health",
};

interface PlaybookCategory { title: string; description: string; changes: boolean; playbooks: string[] }

const CATEGORIES: PlaybookCategory[] = [
  { title: "Checks", description: "Read the state of a host. No packages or services change.", changes: false, playbooks: ["health-check.yml", "service-check.yml", "gather-facts.yml", "patch-check.yml", "reboot-check.yml", "vulnerability-scan.yml"] },
  { title: "Patching", description: "Install updates on the host.", changes: true, playbooks: ["patch-security.yml", "patch-all.yml"] },
  { title: "Setup", description: "Install or configure software on the host.", changes: true, playbooks: ["bootstrap.yml", "install-node-exporter.yml", "install-alloy.yml"] },
  { title: "Power", description: "Takes the host down for a moment.", changes: true, playbooks: ["reboot.yml"] },
];

const known = new Set(CATEGORIES.flatMap((category) => category.playbooks));
const label = (playbook: string) => PLAYBOOK_LABELS[playbook] ?? playbook;
const changesHosts = (playbook: string) => !CATEGORIES.some((category) => !category.changes && category.playbooks.includes(playbook));

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
      <PageHeader title="Run actions" description="Start an Ansible playbook against your servers." actions={<><Button asChild variant="outline"><Link to="/automation/playbooks">Playbook Library</Link></Button></>} />

      {[
        ...CATEGORIES.map((category) => ({ ...category, playbooks: category.playbooks.filter((name) => playbooks.includes(name)) })),
        { title: "Custom playbooks", description: "Added here. Ops Center cannot tell what they do, so treat them as changes.", changes: true, playbooks: playbooks.filter((name) => !known.has(name)) },
      ].filter((category) => category.playbooks.length > 0).map((category) => (
        <section key={category.title} aria-label={category.title} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">{category.title}</h2>
            <Badge variant={category.changes ? "warning" : "ok"}>{category.changes ? "changes hosts" : "read only"}</Badge>
            <p className="basis-full text-xs text-muted-foreground sm:basis-auto">{category.description}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {category.playbooks.map((pb) => (
              <Card key={pb}>
                <CardHeader><CardTitle className="break-words">{label(pb)}</CardTitle></CardHeader>
                <CardContent><Button size="sm" variant="outline" onClick={() => openRunDialog(pb)}>Run</Button></CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      {confirming && selectedPlaybook && (
        <Card>
          <CardHeader>
            <CardTitle>Run {label(selectedPlaybook)}</CardTitle>
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
            {changesHosts(selectedPlaybook) && (
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
