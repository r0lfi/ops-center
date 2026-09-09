import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api, type Credential, type HostGroup } from "@/lib/api";

interface AddServerDialogProps {
  onCreated: () => void;
}

const ENVIRONMENTS = ["production", "test", "development"];
const CRITICALITIES = ["low", "medium", "high", "critical"];
const SECURITY_PATCH_POLICIES = ["disabled", "scan_only", "auto"];
const REBOOT_POLICIES = ["manual", "automatic"];

const DEFAULT_FORM = {
  hostname: "",
  ip_address: "",
  ssh_port: 22,
  ssh_user: "root",
  credential_id: "",
  group_ids: [] as string[],
  environment: "production",
  criticality: "medium",
  tags: "",
  services_to_monitor: "",
  security_patch_policy: "scan_only",
  reboot_policy: "manual",
  description: "",
  latitude: "",
  longitude: "",
  is_docker_host: false,
};

export function AddServerDialog({ onCreated }: AddServerDialogProps) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.hostGroups.list().then(setGroups).catch(() => setGroups([]));
    api.credentials.list().then(setCredentials).catch(() => setCredentials([]));
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.hosts.create({
        hostname: form.hostname,
        ip_address: form.ip_address,
        ssh_port: Number(form.ssh_port),
        ssh_user: form.ssh_user,
        credential_id: form.credential_id || null,
        group_ids: form.group_ids,
        environment: form.environment,
        criticality: form.criticality,
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        services_to_monitor: form.services_to_monitor
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        auto_patch: false,
        security_patch_policy: form.security_patch_policy,
        reboot_policy: form.reboot_policy,
        monitoring_enabled: true,
        log_collection_enabled: true,
        is_docker_host: form.is_docker_host,
        description: form.description || null,
        latitude: form.latitude ? Number(form.latitude) : null,
        longitude: form.longitude ? Number(form.longitude) : null,
      });
      setForm(DEFAULT_FORM);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add Server</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Server</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="hostname">Hostname</Label>
            <Input
              id="hostname"
              required
              value={form.hostname}
              onChange={(e) => setForm({ ...form, hostname: e.target.value })}
              placeholder="example-example-01"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ip_address">IP / FQDN</Label>
            <Input
              id="ip_address"
              required
              value={form.ip_address}
              onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
              placeholder="192.0.2.10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ssh_port">SSH port</Label>
            <Input
              id="ssh_port"
              type="number"
              min={1}
              max={65535}
              required
              value={form.ssh_port}
              onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ssh_user">SSH user</Label>
            <Input
              id="ssh_user"
              required
              value={form.ssh_user}
              onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="credential">Credential</Label>
            <Select
              id="credential"
              value={form.credential_id}
              onChange={(e) => setForm({ ...form, credential_id: e.target.value })}
            >
              <option value="">None (connectivity check only)</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label>Groups</Label>
            <p className="text-xs text-muted-foreground">
              A server can belong to more than one group at once - e.g. an OS-patching group and
              a separate, independently-scheduled group like a Pi-hole gravity update.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border border-border p-3">
              {groups.length === 0 && <span className="text-sm text-muted-foreground">No groups yet</span>}
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.group_ids.includes(g.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        group_ids: e.target.checked
                          ? [...form.group_ids, g.id]
                          : form.group_ids.filter((id) => id !== g.id),
                      })
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </div>

          <div className="col-span-2 flex items-center gap-2">
            <input
              id="is_docker_host"
              type="checkbox"
              checked={form.is_docker_host}
              onChange={(e) => setForm({ ...form, is_docker_host: e.target.checked })}
            />
            <Label htmlFor="is_docker_host" className="cursor-pointer">
              Runs Docker (shows up in Containers → Docker Hosts)
            </Label>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="environment">Environment</Label>
            <Select
              id="environment"
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value })}
            >
              {ENVIRONMENTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="criticality">Criticality</Label>
            <Select
              id="criticality"
              value={form.criticality}
              onChange={(e) => setForm({ ...form, criticality: e.target.value })}
            >
              {CRITICALITIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="web, external-facing"
            />
          </div>

          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="services_to_monitor">Services to monitor (comma-separated systemd units)</Label>
            <Input
              id="services_to_monitor"
              value={form.services_to_monitor}
              onChange={(e) => setForm({ ...form, services_to_monitor: e.target.value })}
              placeholder="sshd.service, docker.service"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="latitude">Latitude (optional, for the Server Map)</Label>
            <Input
              id="latitude"
              type="number"
              step="any"
              min={-90}
              max={90}
              value={form.latitude}
              onChange={(e) => setForm({ ...form, latitude: e.target.value })}
              placeholder="59.91"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="longitude">Longitude</Label>
            <Input
              id="longitude"
              type="number"
              step="any"
              min={-180}
              max={180}
              value={form.longitude}
              onChange={(e) => setForm({ ...form, longitude: e.target.value })}
              placeholder="10.75"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="security_patch_policy">Security patch policy</Label>
            <Select
              id="security_patch_policy"
              value={form.security_patch_policy}
              onChange={(e) => setForm({ ...form, security_patch_policy: e.target.value })}
            >
              {SECURITY_PATCH_POLICIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reboot_policy">Reboot policy</Label>
            <Select
              id="reboot_policy"
              value={form.reboot_policy}
              onChange={(e) => setForm({ ...form, reboot_policy: e.target.value })}
            >
              {REBOOT_POLICIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>

          {error && <p className="col-span-2 text-sm text-status-critical">{error}</p>}

          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding..." : "Add Server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
