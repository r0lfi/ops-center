import { useCallback, useEffect, useState } from "react";
import { Wifi } from "lucide-react";

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
  { component: "Deployment", detail: "Optional legacy wg-easy integration. Configure WG_EASY_URL for a compatible private API. Routing and firewall rules are managed outside Ops Center.", status: "unknown" },
];

function ArchitectureReference() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Architecture reference</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-56 px-4 py-3 font-medium">Component</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {ARCHITECTURE_REFERENCE.map((row) => (
                <tr key={row.component} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="px-4 py-3 font-medium">
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
                  <td className="px-4 py-3 text-muted-foreground">{row.detail}</td>
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

function PeerCard({ peer, onDelete, canManage }: { peer: VpnPeer; onDelete: (id: string) => void; canManage: boolean }) {
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
          <div className="pt-2">
            <Button size="sm" variant="destructive" onClick={() => onDelete(peer.id)}>
              Remove
            </Button>
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
          Creates a WireGuard client on the configured wg-easy server. Download its configuration from your wg-easy interface.
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
  const [error, setError] = useState(false);
  const canManage = hasRole("admin");

  const refresh = useCallback(() => {
    api.vpn
      .list()
      .then((p) => {
        setPeers(p);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleDelete(id: string) {
    if (!confirm("Remove this VPN peer? Its config will stop working immediately.")) return;
    await api.vpn.remove(id);
    refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Wifi className="h-5 w-5" />
            VPN
          </h1>
          <p className="text-sm text-muted-foreground">
            WireGuard peers from the optional wg-easy integration.
          </p>
        </div>
        {canManage && <AddPeerDialog onCreated={refresh} />}
      </div>

      {error && <p className="text-sm text-status-warning">wg-easy is unreachable right now.</p>}

      {peers && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {peers.map((peer) => (
            <PeerCard key={peer.id} peer={peer} onDelete={handleDelete} canManage={canManage} />
          ))}
        </div>
      )}

      <ArchitectureReference />
    </div>
  );
}
