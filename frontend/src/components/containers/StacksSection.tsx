import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

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
import { api, type StackSummary } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

const TEXTAREA_CLASS =
  "flex min-h-[16rem] w-full rounded-md border border-input bg-secondary px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function DeployStackDialog({
  hostname,
  onDeployed,
  triggerLabel = "Deploy stack",
  initialName = "",
  initialComposeYaml = "",
  lockName = false,
  autoOpen = false,
  extraWarning,
}: {
  hostname: string;
  onDeployed: () => void;
  triggerLabel?: string;
  initialName?: string;
  initialComposeYaml?: string;
  lockName?: boolean;
  autoOpen?: boolean;
  extraWarning?: string;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [name, setName] = useState(initialName);
  const [composeYaml, setComposeYaml] = useState(initialComposeYaml);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<{ ok: boolean; stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const confirmed = confirmText === "DEPLOY";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.stacks.deploy(hostname, name, composeYaml);
      setResult(res);
      if (res.ok) onDeployed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to deploy stack");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setName(initialName);
          setComposeYaml(initialComposeYaml);
          setConfirmText("");
          setResult(null);
          setError(null);
        }
      }}
    >
      {!autoOpen && (
        <DialogTrigger asChild>
          <Button variant="destructive">{triggerLabel}</Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy a docker-compose stack on {hostname}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-status-warning">
          This deploys arbitrary containers on {hostname} with whatever the compose file asks for - bind
          mounts, privileged mode, host networking included. Equivalent to root on that host. Only deploy
          something you wrote or fully trust.
        </p>
        {extraWarning && <p className="text-sm text-status-warning">{extraWarning}</p>}
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="stack-name">Stack name</Label>
            <Input
              id="stack-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-stack"
              pattern="^[a-z0-9][a-z0-9_-]*$"
              readOnly={lockName}
              required
            />
            {lockName && (
              <p className="text-xs text-muted-foreground">
                Kept identical to the discovered project name on purpose - Docker names this project's
                volumes after it, and changing the name here would make Compose create fresh, empty
                volumes instead of reusing the existing ones.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-yaml">compose.yml</Label>
            <textarea
              id="stack-yaml"
              className={TEXTAREA_CLASS}
              value={composeYaml}
              onChange={(e) => setComposeYaml(e.target.value)}
              placeholder={"services:\n  app:\n    image: example/app:1.0\n    restart: unless-stopped"}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stack-confirm">Type DEPLOY to confirm</Label>
            <Input id="stack-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
          {result && (
            <div className="space-y-1 rounded-md border border-border bg-secondary p-2">
              <p className={result.ok ? "text-sm text-status-ok" : "text-sm text-destructive"}>
                {result.ok ? "Deployed." : "Failed."}
              </p>
              {result.stdout && <pre className="max-h-40 overflow-y-auto text-xs">{result.stdout}</pre>}
              {result.stderr && <pre className="max-h-40 overflow-y-auto text-xs text-destructive">{result.stderr}</pre>}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={!confirmed || submitting}>
              {submitting ? "Deploying..." : "Deploy"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AdoptStackDialog({
  hostname,
  name,
  onAdopted,
}: {
  hostname: string;
  name: string;
  onAdopted: () => void;
}) {
  const [preview, setPreview] = useState<{ compose_yaml: string; suggested_name: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.stacks.adoptPreview(hostname, name));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to preview stack");
    } finally {
      setLoading(false);
    }
  }

  if (preview) {
    return (
      <DeployStackDialog
        hostname={hostname}
        onDeployed={() => {
          setPreview(null);
          onAdopted();
        }}
        autoOpen
        lockName
        initialName={preview.suggested_name}
        initialComposeYaml={preview.compose_yaml}
        extraWarning="This stack wasn't deployed through Ops Center - reconstructed from the running containers' own config, not their original compose file (which isn't reliably readable regardless of how the stack was originally deployed). Review it below. Deploying will very likely restart this stack's container(s) once, even though nothing meaningful is changing - Compose sees this as a fresh deploy. Data in bind mounts and named volumes is preserved either way."
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={loading} onClick={start}>
        {loading ? "Loading..." : "Adopt"}
      </Button>
      {error && <p className="text-xs text-status-critical">{error}</p>}
    </div>
  );
}

function RemoveStackDialog({
  hostname,
  name,
  onRemoved,
}: {
  hostname: string;
  name: string;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    try {
      const res = await api.stacks.remove(hostname, name);
      if (res.ok) {
        setOpen(false);
        onRemoved();
      } else {
        setError(res.stderr || "remove failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to remove stack");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove stack "{name}"?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Runs <code className="font-mono">docker compose down --volumes</code> on {hostname} - every
          container and volume this stack owns is deleted.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleRemove} disabled={removing}>
            {removing ? "Removing..." : "Remove stack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StacksSection({ hostname }: { hostname: string }) {
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.stacks
      .list(hostname)
      .then((data) => {
        setStacks(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load stacks"));
  }, [hostname]);

  useEffect(refresh, [refresh]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Compose Stacks</CardTitle>
        <DeployStackDialog hostname={hostname} onDeployed={refresh} />
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {stacks.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No compose stacks found on this host.</p>
        )}
        {stacks.map((stack) => (
          <div
            key={stack.name}
            className="flex items-center justify-between rounded-md border border-border p-2 text-sm"
          >
            <div>
              <div className="flex items-center gap-2">
                {stack.managed ? (
                  <Link
                    to={`/containers/${encodeURIComponent(hostname)}/stacks/${encodeURIComponent(stack.name)}`}
                    className="font-medium hover:underline"
                  >
                    {stack.name}
                  </Link>
                ) : (
                  <span className="font-medium">{stack.name}</span>
                )}
                {!stack.managed && <Badge variant="unknown">Not managed by Ops Center</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {stack.running_count}/{stack.container_count} running
                {stack.managed && <> · deployed {formatRelativeTime(stack.last_deployed_at)}</>}
              </p>
            </div>
            {stack.managed ? (
              <RemoveStackDialog hostname={hostname} name={stack.name} onRemoved={refresh} />
            ) : (
              <AdoptStackDialog hostname={hostname} name={stack.name} onAdopted={refresh} />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
