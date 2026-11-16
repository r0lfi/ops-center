import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
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
import { api, type Registry } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";

const DEFAULT_FORM = {
  name: "",
  url: "",
  username: "",
  secret_filename: "",
  auth_required: true,
  description: "",
};

function AddRegistryDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.registries.create({
        name: form.name,
        url: form.url,
        username: form.username || null,
        secret_filename: form.secret_filename || null,
        auth_required: form.auth_required,
        description: form.description || null,
      });
      setForm(DEFAULT_FORM);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create registry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add Registry</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Registry</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Raw credentials are never accepted here. If this registry needs auth, place the
          password/token in a file under{" "}
          <code className="font-mono">/data/ops-center/secrets/registries/</code> first, then
          reference just the filename below.
        </p>
        <form className="grid grid-cols-2 gap-4" onSubmit={handleSubmit}>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="registry-name">Name</Label>
            <Input
              id="registry-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Docker Hub"
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="registry-url">Registry URL</Label>
            <Input
              id="registry-url"
              required
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="ghcr.io"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="registry-username">Username</Label>
            <Input
              id="registry-username"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="registry-secret">Secret filename</Label>
            <Input
              id="registry-secret"
              value={form.secret_filename}
              onChange={(e) => setForm({ ...form, secret_filename: e.target.value })}
              placeholder="ghcr-token"
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="registry-description">Description</Label>
            <Input
              id="registry-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              id="registry-auth-required"
              type="checkbox"
              checked={form.auth_required}
              onChange={(e) => setForm({ ...form, auth_required: e.target.checked })}
            />
            <Label htmlFor="registry-auth-required" className="cursor-pointer">
              Requires authentication
            </Label>
          </div>
          {error && <p className="col-span-2 text-sm text-status-critical">{error}</p>}
          <DialogFooter className="col-span-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Adding..." : "Add Registry"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Registries() {
  const { hasRole } = useAuth();
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [removing, setRemoving] = useState<Registry | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.registries.list().then(setRegistries).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await api.registries.remove(removing.id);
      setRemoving(null);
      refresh();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove this registry");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Registries" description={<>Container registries used for pulling images and checking for updates. Credentials are
            stored on disk, never in the database, and never sent back to the browser.</>} actions={<>{hasRole("admin") && <AddRegistryDialog onCreated={refresh} />}</>} />

      <Card>
        <CardHeader>
          <CardTitle>Configured registries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {registries.length === 0 && (
            <p className="text-sm text-muted-foreground">
              None configured. Public images (Docker Hub, GHCR, lscr.io, etc.) still work without
              one - only needed for private images or to raise anonymous rate limits.
            </p>
          )}
          {registries.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              <div>
                <span className="font-medium">{r.name}</span>
                <p className="font-mono text-xs text-muted-foreground">{r.url}</p>
                {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
              </div>
              <div className="flex items-center gap-3">
                {r.username && <span className="text-xs text-muted-foreground">{r.username}</span>}
                {hasRole("admin") && (
                  <OverflowMenu label={`More actions for ${r.name}`} items={[{ label: "Remove registry", destructive: true, onSelect: () => { setRemoveError(null); setRemoving(r); } }]} />
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <ConfirmDialog open={removing !== null} title={`Remove registry "${removing?.name ?? ""}"?`} confirmLabel="Remove registry" busy={busy} error={removeError} onCancel={() => setRemoving(null)} onConfirm={remove}>
        Its stored credentials are deleted. Pulls from a private image in this registry stop working until you add it again.
      </ConfirmDialog>
    </div>
  );
}
