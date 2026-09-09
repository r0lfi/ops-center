import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type StackContainer, type StackSummary } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TEXTAREA_CLASS =
  "flex min-h-[28rem] w-full rounded-md border border-input bg-secondary px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
import { formatRelativeTime } from "@/lib/format";

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  running: "ok",
  exited: "critical",
  restarting: "warning",
  paused: "unknown",
  created: "unknown",
};

function OverviewTab({ summary }: { summary: StackSummary | null }) {
  if (!summary) return <p className="text-sm text-muted-foreground">Loading...</p>;
  return (
    <Card>
      <CardContent className="space-y-2 py-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Source</span>
          <span>{summary.source}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Containers</span>
          <span>
            {summary.running_count}/{summary.container_count} running
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Created</span>
          <span>{formatRelativeTime(summary.created_at)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Last deployed</span>
          <span>{formatRelativeTime(summary.last_deployed_at)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ContainersTab({ hostname, name }: { hostname: string; name: string }) {
  const [containers, setContainers] = useState<StackContainer[] | null>(null);

  useEffect(() => {
    api.stacks.containers(hostname, name).then(setContainers).catch(() => setContainers([]));
  }, [hostname, name]);

  if (containers === null) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Image</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Health</th>
          </tr>
        </thead>
        <tbody>
          {containers.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                No containers.
              </td>
            </tr>
          )}
          {containers.map((c) => (
            <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/50">
              <td className="px-4 py-3 font-medium">
                <Link to={`/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(c.name)}`} className="hover:underline">
                  {c.name}
                </Link>
              </td>
              <td className="max-w-xs truncate px-4 py-3 font-mono text-xs">{c.image}</td>
              <td className="px-4 py-3">
                <Badge variant={STATUS_VARIANT[c.status] ?? "unknown"}>{c.status}</Badge>
              </td>
              <td className="px-4 py-3">{c.health ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComposeTab({ hostname, name }: { hostname: string; name: string }) {
  const { hasRole } = useAuth();
  const [composeYaml, setComposeYaml] = useState<string | null>(null);
  const [savedYaml, setSavedYaml] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; stdout: string; stderr: string } | null>(null);

  useEffect(() => {
    api.stacks
      .get(hostname, name)
      .then((r) => {
        setComposeYaml(r.compose_yaml);
        setSavedYaml(r.compose_yaml);
        setPath(r.path);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load compose file"));
  }, [hostname, name]);

  async function save() {
    if (composeYaml === null) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await api.stacks.deploy(hostname, name, composeYaml);
      setResult(res);
      if (res.ok) setSavedYaml(composeYaml);
    } catch (err) {
      setResult({ ok: false, stdout: "", stderr: err instanceof Error ? err.message : "failed to save" });
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  }

  if (error) return <p className="text-sm text-status-critical">{error}</p>;
  if (composeYaml === null) return <p className="text-sm text-muted-foreground">Loading...</p>;

  const dirty = composeYaml !== savedYaml;
  const canEdit = hasRole("admin");

  return (
    <div className="space-y-2">
      {path && (
        <p className="text-xs text-muted-foreground">
          Path on {hostname}: <span className="font-mono">{path}</span>
        </p>
      )}
      {canEdit ? (
        <textarea
          className={TEXTAREA_CLASS}
          value={composeYaml}
          onChange={(e) => setComposeYaml(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <pre className="max-h-[36rem] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">
          {composeYaml}
        </pre>
      )}
      {result && (
        <div className="space-y-1 rounded-md border border-border bg-secondary p-2">
          <p className={result.ok ? "text-sm text-status-ok" : "text-sm text-destructive"}>
            {result.ok ? "Saved and redeployed." : "Failed."}
          </p>
          {result.stdout && <pre className="max-h-40 overflow-y-auto text-xs">{result.stdout}</pre>}
          {result.stderr && <pre className="max-h-40 overflow-y-auto text-xs text-destructive">{result.stderr}</pre>}
        </div>
      )}
      {canEdit && (
        <div className="flex items-center gap-2">
          <Button disabled={!dirty || saving} onClick={() => setConfirmOpen(true)}>
            {saving ? "Saving..." : "Save & redeploy"}
          </Button>
          {dirty && (
            <Button variant="outline" disabled={saving} onClick={() => setComposeYaml(savedYaml)}>
              Discard changes
            </Button>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save and redeploy "{name}"?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Writes this compose file to {hostname} and runs <code className="font-mono">docker compose up -d</code>{" "}
            - any service whose configuration changed is recreated (briefly restarted). Services with no real
            change are left running.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving..." : "Save & redeploy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionsTab({ hostname, name }: { hostname: string; name: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; stdout: string; stderr: string } | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState<"stop" | "restart" | null>(null);

  async function run(action: "start" | "stop" | "restart" | "pull") {
    setBusy(action);
    setResult(null);
    try {
      const res = await api.stacks.action(hostname, name, action);
      setResult(res);
    } finally {
      setBusy(null);
      setConfirmDestructive(null);
    }
  }

  function request(action: "start" | "stop" | "restart" | "pull") {
    if (action === "stop" || action === "restart") setConfirmDestructive(action);
    else run(action);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!!busy} onClick={() => request("start")}>
          {busy === "start" ? "..." : "Start"}
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => request("stop")}>
          {busy === "stop" ? "..." : "Stop"}
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => request("restart")}>
          {busy === "restart" ? "..." : "Restart"}
        </Button>
        <Button variant="outline" disabled={!!busy} onClick={() => request("pull")}>
          {busy === "pull" ? "..." : "Pull images"}
        </Button>
      </div>
      {result && (
        <div className="space-y-1 rounded-md border border-border bg-secondary p-2">
          <p className={result.ok ? "text-sm text-status-ok" : "text-sm text-destructive"}>
            {result.ok ? "Succeeded." : "Failed."}
          </p>
          {result.stdout && <pre className="max-h-60 overflow-y-auto text-xs">{result.stdout}</pre>}
          {result.stderr && <pre className="max-h-60 overflow-y-auto text-xs text-muted-foreground">{result.stderr}</pre>}
        </div>
      )}

      <Dialog open={confirmDestructive !== null} onOpenChange={(open) => !open && setConfirmDestructive(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDestructive === "stop" ? "Stop" : "Restart"} every container in "{name}"?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">This affects every service in the stack on {hostname}.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDestructive(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => confirmDestructive && run(confirmDestructive)}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function StackDetail() {
  const { hostname = "", name = "" } = useParams<{ hostname: string; name: string }>();
  const { hasRole } = useAuth();
  const [summary, setSummary] = useState<StackSummary | null>(null);

  const refresh = useCallback(() => {
    api.stacks
      .list(hostname)
      .then((rows) => setSummary(rows.find((s) => s.name === name) ?? null));
  }, [hostname, name]);

  useEffect(refresh, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to={`/containers/${encodeURIComponent(hostname)}`} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">
            <Link to="/containers" className="hover:underline">
              Containers
            </Link>{" "}
            /{" "}
            <Link to={`/containers/${encodeURIComponent(hostname)}`} className="hover:underline">
              {hostname}
            </Link>{" "}
            / Stacks
          </p>
          <h1 className="text-2xl font-semibold">{name}</h1>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="containers">Containers</TabsTrigger>
          <TabsTrigger value="compose">Compose</TabsTrigger>
          {hasRole("admin") && <TabsTrigger value="actions">Actions</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab summary={summary} />
        </TabsContent>
        <TabsContent value="containers">
          <ContainersTab hostname={hostname} name={name} />
        </TabsContent>
        <TabsContent value="compose">
          <ComposeTab hostname={hostname} name={name} />
        </TabsContent>
        {hasRole("admin") && (
          <TabsContent value="actions">
            <ActionsTab hostname={hostname} name={name} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
