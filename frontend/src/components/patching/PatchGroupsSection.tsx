import { Link, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { Select } from "@/components/ui/select";
import { api, type Host, type HostGroup } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

const DAYS = [
  { label: "Monday", value: 1 },
  { label: "Tuesday", value: 2 },
  { label: "Wednesday", value: 3 },
  { label: "Thursday", value: 4 },
  { label: "Friday", value: 5 },
  { label: "Saturday", value: 6 },
  { label: "Sunday", value: 0 },
];
const DAY_LABEL = Object.fromEntries(DAYS.map((d) => [d.value, d.label]));

function cronFromDayTime(day: number, time: string): string {
  const [hh, mm] = time.split(":").map(Number);
  return `${mm} ${hh} * * ${day}`;
}

/** Only parses the "MM HH * * D" shape this page itself generates - a
 * cron_expression set some other way just won't populate the day/time
 * pickers on edit, which is fine (still shown as raw text elsewhere). */
function dayTimeFromCron(cron: string | null): { day: number; time: string } | null {
  if (!cron) return null;
  const parts = cron.split(" ");
  if (parts.length !== 5 || parts[2] !== "*" || parts[3] !== "*") return null;
  const mm = Number(parts[0]);
  const hh = Number(parts[1]);
  const day = Number(parts[4]);
  if ([mm, hh, day].some(Number.isNaN)) return null;
  return { day, time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
}

function describeSchedule(group: HostGroup): string {
  if (!group.cron_expression) return "No schedule";
  const parsed = dayTimeFromCron(group.cron_expression);
  const patchLabel =
    group.patch_type === "all"
      ? "all updates"
      : group.patch_type === "pihole"
        ? "Pi-hole update"
        : "security updates";
  if (!parsed) return `${group.cron_expression} (${patchLabel})`;
  return `${DAY_LABEL[parsed.day] ?? parsed.day} ${parsed.time} · ${patchLabel}`;
}

interface GroupFormState {
  name: string;
  description: string;
  scheduled: boolean;
  day: number;
  time: string;
  patch_type: "security" | "all" | "pihole";
  batch_size: number;
  schedule_enabled: boolean;
}

const DEFAULT_FORM: GroupFormState = {
  name: "",
  description: "",
  scheduled: false,
  day: 1,
  time: "03:00",
  patch_type: "security",
  batch_size: 1,
  schedule_enabled: true,
};

function GroupFormDialog({
  group,
  allHosts = [],
  onSaved,
}: {
  group?: HostGroup;
  allHosts?: Host[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<GroupFormState>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (group) {
      const parsed = dayTimeFromCron(group.cron_expression);
      setForm({
        name: group.name,
        description: group.description ?? "",
        scheduled: !!group.cron_expression,
        day: parsed?.day ?? 1,
        time: parsed?.time ?? "03:00",
        patch_type: group.patch_type ?? "security",
        batch_size: group.batch_size,
        schedule_enabled: group.schedule_enabled,
      });
    } else {
      setForm(DEFAULT_FORM);
    }
    setError(null);
  }, [open, group]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        cron_expression: form.scheduled ? cronFromDayTime(form.day, form.time) : null,
        patch_type: form.scheduled ? form.patch_type : null,
        batch_size: form.batch_size,
        schedule_enabled: form.scheduled ? form.schedule_enabled : false,
      };
      if (group) {
        await api.hostGroups.update(group.id, payload);
      } else {
        await api.hostGroups.create(payload);
      }
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save group");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={group ? "outline" : "default"} size={group ? "sm" : "default"}>
          {group ? "Edit" : "Create patch group"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : "Create patch group"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              placeholder="Autopatch_mandag_kl3"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-desc">Description</Label>
            <Input
              id="group-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.scheduled}
              onChange={(e) => setForm({ ...form, scheduled: e.target.checked })}
            />
            Auto-patch this group on a schedule
          </label>
          {form.scheduled && (
            <div className="space-y-4 rounded-md border border-border p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="group-day">Day</Label>
                  <Select
                    id="group-day"
                    value={form.day}
                    onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}
                  >
                    {DAYS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="group-time">Time</Label>
                  <Input
                    id="group-time"
                    type="time"
                    value={form.time}
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="group-patch-type">Patch type</Label>
                  <Select
                    id="group-patch-type"
                    value={form.patch_type}
                    onChange={(e) =>
                      setForm({ ...form, patch_type: e.target.value as "security" | "all" | "pihole" })
                    }
                  >
                    <option value="security">Security updates only</option>
                    <option value="all">All updates</option>
                    <option value="pihole">Pi-hole update (pihole -up)</option>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="group-batch">Batch size (hosts in parallel)</Label>
                  <Input
                    id="group-batch"
                    type="number"
                    min={1}
                    value={form.batch_size}
                    onChange={(e) => setForm({ ...form, batch_size: Number(e.target.value) })}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.schedule_enabled}
                  onChange={(e) => setForm({ ...form, schedule_enabled: e.target.checked })}
                />
                Schedule active (uncheck to pause without losing the configuration)
              </label>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
        {group && <GroupMemberEditor group={group} allHosts={allHosts} onChanged={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function GroupMemberEditor({ group, allHosts, onChanged }: { group: HostGroup; allHosts: Host[]; onChanged: () => void }) {
  const [adding, setAdding] = useState("");
  const memberIds = new Set(group.hosts.map((h) => h.id));
  const available = allHosts.filter((h) => !memberIds.has(h.id));

  async function addSelected() {
    if (!adding) return;
    await api.hostGroups.addHost(group.id, adding);
    setAdding("");
    onChanged();
  }

  async function remove(hostId: string) {
    await api.hostGroups.removeHost(group.id, hostId);
    onChanged();
  }

  return (
    <section aria-label="Servers in this group" className="space-y-2 border-t border-border pt-3">
      <h3 className="text-sm font-medium">Servers in this group</h3>
      <p className="text-xs text-muted-foreground">Changes here apply at once. A server can only belong to one group at a time, so adding it here moves it out of any other group.</p>
      <div className="flex flex-wrap gap-1.5">
        {group.hosts.length === 0 && <span className="text-xs text-muted-foreground">No servers yet.</span>}
        {group.hosts.map((h) => (
          <Badge key={h.id} variant="secondary" className="gap-1.5">
            {h.hostname}
            <button type="button" onClick={() => remove(h.id)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${h.hostname} from group`} title="Remove from group">&times;</button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Select aria-label="Server to add" value={adding} onChange={(e) => setAdding(e.target.value)} className="h-8 max-w-xs text-xs">
          <option value="">Add server...</option>
          {available.map((h) => <option key={h.id} value={h.id}>{h.hostname}</option>)}
        </Select>
        <Button type="button" size="sm" variant="outline" onClick={addSelected} disabled={!adding}>Add</Button>
      </div>
    </section>
  );
}

export function PatchGroupsSection() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [groups, setGroups] = useState<HostGroup[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<HostGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([api.hostGroups.list(), api.hosts.list()])
      .then(([g, h]) => {
        setGroups(g);
        setHosts(h);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load patch groups"));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function runNow(group: HostGroup) {
    setRunningId(group.id);
    try {
      const job = await api.hostGroups.runNow(group.id);
      navigate(`/patching/reports?group=${encodeURIComponent(group.name)}&run=${job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start patch run");
    } finally {
      setRunningId(null);
    }
  }

  async function removeGroup() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.hostGroups.remove(deleting.id);
      setDeleting(null);
      refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete this group");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Patch Groups</CardTitle>
        {hasRole("admin") && <GroupFormDialog onSaved={refresh} />}
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {groups.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">
            No patch groups yet. Create one to auto-patch a named set of servers on a schedule.
          </p>
        )}
        {groups.map((group) => (
          <div key={group.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{group.name}</span>
                  {group.cron_expression && (
                    <Badge variant={group.schedule_enabled ? "ok" : "unknown"}>
                      {group.schedule_enabled ? "active" : "paused"}
                    </Badge>
                  )}
                </div>
                {group.description && <p className="text-xs text-muted-foreground">{group.description}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{describeSchedule(group)}</p>
                {group.last_triggered_at && (
                  <p className="text-xs text-muted-foreground">
                    Last run: {formatDateTime(group.last_triggered_at)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline"><Link to={`/patching/reports?group=${encodeURIComponent(group.name)}`}>Reports</Link></Button>
                {hasRole("operator") && group.patch_type && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runNow(group)}
                    disabled={runningId === group.id || group.hosts.length === 0}
                  >
                    {runningId === group.id ? "Running..." : "Run now"}
                  </Button>
                )}
                {hasRole("admin") && <GroupFormDialog group={group} allHosts={hosts} onSaved={refresh} />}
                {hasRole("admin") && <OverflowMenu label={`More actions for ${group.name}`} items={[{ label: "Delete group", destructive: true, onSelect: () => { setDeleteError(null); setDeleting(group); } }]} />}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {group.hosts.length === 0 && <span className="text-xs text-muted-foreground">No servers yet.</span>}
              {group.hosts.map((h) => <Badge key={h.id} variant="secondary">{h.hostname}</Badge>)}
            </div>
          </div>
        ))}
        <ConfirmDialog open={deleting !== null} title={`Delete group "${deleting?.name ?? ""}"?`} confirmLabel="Delete group" busy={busy} error={deleteError} onCancel={() => setDeleting(null)} onConfirm={removeGroup}>
          Member servers are unaffected.
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}
