import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OverflowMenu } from "@/components/ui/overflow-menu";
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
import { api, type VpnPeer } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

// A peer whose last handshake is older than this (but still enabled) reads
// as "connected but stale" rather than "online" - WireGuard has no real
// disconnect event, only silence, so this is a judgment call, not a fact.
const STALE_AFTER_SECONDS = 180;

const ARCHITECTURE_REFERENCE: { component: string; detail: string; status?: "ok" | "warning" | "unknown" }[] = [
  { component: "Integration", detail: "Optional wg-easy v14 session API over HTTPS. Configure WIREGUARD_URL and its password file. Routing and firewall rules are managed outside Ops Center.", status: "unknown" },
];

function ArchitectureReference() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Architecture reference</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="ops-card-table w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-56 px-4 py-3 font-medium">Component</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {ARCHITECTURE_REFERENCE.map((row) => (
                <tr key={row.component} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td data-label="Component" className="px-4 py-3 font-medium">
                    <span className="flex items-center gap-2">
                      {row.status && (
                        <span
                          className={
                            "h-1.5 w-1.5 shrink-0 rounded-full " +
                            (row.status === "ok"
                              ? "bg-status-ok"
                              : row.status === "warning"
                                ? "bg-status-warning"
                                : "bg-status-unknown")
                          }
                        />
                      )}
                      {row.component}
                    </span>
                  </td>
                  <td data-label="Detail" className="px-4 py-3 text-muted-foreground">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function peerVariant(peer: VpnPeer): "ok" | "warning" | "critical" {
  if (!peer.enabled) return "critical";
  if (!peer.latest_handshake_at) return "warning";
  const age = (Date.now() - new Date(peer.latest_handshake_at).getTime()) / 1000;
  return age < STALE_AFTER_SECONDS ? "ok" : "warning";
}

function PeerCard({ peer, onDelete, canManage }: { peer: VpnPeer; onDelete: (peer: VpnPeer) => void; canManage: boolean }) {
  const variant = peerVariant(peer);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{peer.name}</span>
          <Badge variant={variant}>
            {!peer.enabled ? "disabled" : variant === "ok" ? "connected" : "no recent handshake"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tunnel address</span>
          <span className="font-mono">{peer.address}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last handshake</span>
          <span>{formatRelative(peer.latest_handshake_at)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Transfer</span>
          <span>{formatBytes(peer.transfer_rx)} in / {formatBytes(peer.transfer_tx)} out</span>
        </div>
        {peer.note && (
          <p className="rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-xs text-status-warning">
            {peer.note}
          </p>
        )}
        {canManage && (
          <div className="flex justify-end pt-2">
            <OverflowMenu label={`More actions for ${peer.name}`} items={[{ label: "Remove peer", destructive: true, onSelect: () => onDelete(peer) }]} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddPeerDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.vpn.create(name.trim());
      setName("");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create peer");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New peer</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New VPN peer</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Creates a WireGuard client with the routing defaults of your configured wg-easy server. Download the configuration from its administration interface.
        </p>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="peer-name">Name</Label>
            <Input
              id="peer-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="example_laptop"
            />
          </div>
          {error && <p className="text-sm text-status-critical">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Vpn() {
  const { hasRole } = useAuth();
  const [peers, setPeers] = useState<VpnPeer[] | null>(null);
  const [removing, setRemoving] = useState<VpnPeer | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasRole("admin");

  const refresh = useCallback(() => {
    api.vpn
      .list()
      .then((p) => {
        setPeers(p);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load WireGuard peers."));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleDelete() {
    if (!removing) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await api.vpn.remove(removing.id);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove this peer");
      setBusy(false);
      return;
    }
    setBusy(false);
    setRemoving(null);
    refresh();
  }

  return (
    <div className="space-y-6">
      <PageHeader title="VPN" description={<>Manage peers through the configured WireGuard integration. Ops Center authenticates on the server; credentials are never sent to your browser.</>} actions={<>{canManage && <AddPeerDialog onCreated={refresh} />}</>} />

      {error && <p className="text-sm text-status-warning">{error}</p>}

      {peers && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {peers.map((peer) => (
            <PeerCard key={peer.id} peer={peer} onDelete={(target) => { setRemoveError(null); setRemoving(target); }} canManage={canManage} />
          ))}
        </div>
      )}

      <ArchitectureReference />

      <ConfirmDialog open={removing !== null} title={`Remove VPN peer "${removing?.name ?? ""}"?`} confirmLabel="Remove peer" busy={busy} error={removeError} onCancel={() => setRemoving(null)} onConfirm={handleDelete}>
        Its config stops working immediately.
      </ConfirmDialog>
    </div>
  );
}
