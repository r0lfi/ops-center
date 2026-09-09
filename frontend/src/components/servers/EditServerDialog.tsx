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
import { api, type Credential, type Host, type HostGroup } from "@/lib/api";

interface EditServerDialogProps {
  host: Host;
  onSaved: () => void;
}

const ENVIRONMENTS = ["production", "test", "development"];
const CRITICALITIES = ["low", "medium", "high", "critical"];
const SECURITY_PATCH_POLICIES = ["disabled", "scan_only", "auto"];
const REBOOT_POLICIES = ["manual", "automatic"];

export function EditServerDialog({ host, onSaved }: EditServerDialogProps) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    ip_address: host.ip_address,
    monitoring_ip_address: host.monitoring_ip_address ?? "",
    ssh_port: host.ssh_port,
    ssh_user: host.ssh_user,
    credential_id: host.credential_id ?? "",
    group_ids: host.group_ids,
    environment: host.environment,
    criticality: host.criticality,
    tags: host.tags.join(", "),
    security_patch_policy: host.security_patch_policy,
    reboot_policy: host.reboot_policy,
    description: host.description ?? "",
    latitude: host.latitude != null ? String(host.latitude) : "",
    longitude: host.longitude != null ? String(host.longitude) : "",
    is_docker_host: host.is_docker_host,
  });

  useEffect(() => {
    if (!open) return;
    api.hostGroups.list().then(setGroups).catch(() => setGroups([]));
    api.credentials.list().then(setCredentials).catch(() => setCredentials([]));
    setForm({
      ip_address: host.ip_address,
    monitoring_ip_address: host.monitoring_ip_address ?? "",
      ssh_port: host.ssh_port,
      ssh_user: host.ssh_user,
      credential_id: host.credential_id ?? "",
      group_ids: host.group_ids,
      environment: host.environment,
      criticality: host.criticality,
      tags: host.tags.join(", "),
      security_patch_policy: host.security_patch_policy,
      reboot_policy: host.reboot_policy,
      description: host.description ?? "",
      latitude: host.latitude != null ? String(host.latitude) : "",
      longitude: host.longitude != null ? String(host.longitude) : "",
      is_docker_host: host.is_docker_host,
    });
    setError(null);
  }, [open, host]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.hosts.update(host.id, {
        ip_address: form.ip_address,
        monitoring_ip_address: form.monitoring_ip_address.trim() || null,
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
        security_patch_policy: form.security_patch_policy,
        reboot_policy: form.reboot_policy,
        description: form.description || null,
        latitude: form.latitude === "" ? null : Number(form.latitude),
        longitude: form.longitude === "" ? null : Number(form.longitude),
        is_docker_host: form.is_docker_host,
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {host.hostname}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-ip">IP / FQDN</Label>
            <Input
              id="edit-ip"
              required
              value={form.ip_address}
              onChange={(e) => setForm({ ...form, ip_address: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-monitoring-ip">Monitoring IP (optional)</Label>
            <Input
              id="edit-monitoring-ip"
              value={form.monitoring_ip_address}
              onChange={(e) => setForm({ ...form, monitoring_ip_address: e.target.value })}
              placeholder="Defaults to IP / FQDN above"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-port">SSH port</Label>
            <Input
              id="edit-port"
              type="number"
              min={1}
              max={65535}
              required
              value={form.ssh_port}
              onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-user">SSH user</Label>
            <Input
              id="edit-user"
              required
              value={form.ssh_user}
              onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-credential">Credential</Label>
            <Select
              id="edit-credential"
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
              id="edit-is-docker-host"
              type="checkbox"
              checked={form.is_docker_host}
              onChange={(e) => setForm({ ...form, is_docker_host: e.target.checked })}
            />
            <Label htmlFor="edit-is-docker-host" className="cursor-pointer">
              Runs Docker (shows up in Containers → Docker Hosts)
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-env">Environment</Label>
            <Select id="edit-env" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
              {ENVIRONMENTS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-crit">Criticality</Label>
            <Select id="edit-crit" value={form.criticality} onChange={(e) => setForm({ ...form, criticality: e.target.value })}>
              {CRITICALITIES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="edit-tags">Tags (comma-separated)</Label>
            <Input id="edit-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-latitude">Latitude (optional, for the Server Map)</Label>
            <Input
              id="edit-latitude"
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
            <Label htmlFor="edit-longitude">Longitude</Label>
            <Input
              id="edit-longitude"
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
            <Label htmlFor="edit-patch-policy">Security patch policy</Label>
            <Select
              id="edit-patch-policy"
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
            <Label htmlFor="edit-reboot-policy">Reboot policy</Label>
            <Select
              id="edit-reboot-policy"
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
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="edit-description">Description</Label>
            <Input
              id="edit-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
