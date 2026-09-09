import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, type ContainerInfo } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";

const STATUS_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  running: "ok",
  exited: "critical",
  restarting: "warning",
  paused: "unknown",
  created: "unknown",
};

const HEALTH_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  healthy: "ok",
  unhealthy: "critical",
  starting: "warning",
};

const FILTERS = ["All", "Running", "Stopped", "Paused", "Restarting", "Unhealthy", "Healthy"] as const;
type Filter = (typeof FILTERS)[number];

const PAGE_SIZE = 20;

type SortKey = "name" | "status" | "restart_count" | "last_seen";

function matchesFilter(c: ContainerInfo, filter: Filter): boolean {
  switch (filter) {
    case "All":
      return true;
    case "Running":
      return c.status === "running";
    case "Stopped":
      return c.status === "exited" || c.status === "created";
    case "Paused":
      return c.status === "paused";
    case "Restarting":
      return c.status === "restarting";
    case "Unhealthy":
      return c.health === "unhealthy";
    case "Healthy":
      return c.health === "healthy";
  }
}

export function HostContainersTable({ hostname }: { hostname: string }) {
  const { hasRole } = useAuth();
  const { showSuccess } = useToast();
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<"stop" | "restart" | null>(null);

  const refresh = () => api.containers.list(hostname).then(setContainers).catch(() => {});

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostname]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = containers.filter(
      (c) =>
        matchesFilter(c, filter) &&
        (q === "" || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q)),
    );
    rows.sort((a, b) => {
      const dir = sortDesc ? -1 : 1;
      if (sortKey === "restart_count") return (a.restart_count - b.restart_count) * dir;
      if (sortKey === "last_seen") return a.last_seen.localeCompare(b.last_seen) * dir;
      return String(a[sortKey]).localeCompare(String(b[sortKey])) * dir;
    });
    return rows;
  }, [containers, search, filter, sortKey, sortDesc]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(false);
    }
  }

  function toggleSelected(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function runAction(name: string, action: "start" | "stop" | "restart") {
    setBusy(`${name}:${action}`);
    try {
      await api.containers[action](hostname, name);
      refresh();
    } finally {
      setBusy(null);
    }
  }

  async function runBulk(action: "start" | "stop" | "restart") {
    setConfirmBulk(null);
    const names = Array.from(selected);
    setBusy(`bulk:${action}`);
    try {
      const result = await api.containers.bulkAction(hostname, names, action);
      const failed = result.results.filter((r) => !r.ok);
      if (failed.length === 0) showSuccess(`${action} succeeded on ${names.length} container(s)`);
      setSelected(new Set());
      refresh();
    } finally {
      setBusy(null);
    }
  }

  function requestBulk(action: "start" | "stop" | "restart") {
    if (action === "start") {
      runBulk("start");
    } else {
      setConfirmBulk(action);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search name or image..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <Select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as Filter);
            setPage(1);
          }}
          className="w-40"
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
        {hasRole("admin") && selected.size > 0 && (
          <div className="flex items-center gap-1.5 border-l border-border pl-2">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => requestBulk("start")}>
              Start selected
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => requestBulk("stop")}>
              Stop selected
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => requestBulk("restart")}>
              Restart selected
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              {hasRole("admin") && (
                <th className="w-8 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={pageRows.length > 0 && pageRows.every((c) => selected.has(c.name))}
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const c of pageRows) {
                          if (e.target.checked) next.add(c.name);
                          else next.delete(c.name);
                        }
                        return next;
                      });
                    }}
                  />
                </th>
              )}
              <th className="cursor-pointer px-4 py-3 font-medium" onClick={() => toggleSort("name")}>
                Name
              </th>
              <th className="px-4 py-3 font-medium">Image</th>
              <th className="cursor-pointer px-4 py-3 font-medium" onClick={() => toggleSort("status")}>
                Status
              </th>
              <th className="px-4 py-3 font-medium">Health</th>
              <th className="cursor-pointer px-4 py-3 font-medium" onClick={() => toggleSort("restart_count")}>
                Restarts
              </th>
              <th className="px-4 py-3 font-medium">Vulnerabilities</th>
              {hasRole("admin") && <th className="px-4 py-3 font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No containers match.
                </td>
              </tr>
            )}
            {pageRows.map((c) => (
              <tr key={c.name} className="border-b border-border last:border-0 hover:bg-accent/50">
                {hasRole("admin") && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(c.name)}
                      onChange={() => toggleSelected(c.name)}
                    />
                  </td>
                )}
                <td className="px-4 py-3 font-medium">
                  <Link
                    to={`/containers/${encodeURIComponent(hostname)}/${encodeURIComponent(c.name)}`}
                    className="hover:underline"
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="max-w-xs truncate px-4 py-3 font-mono text-xs">{c.image}</td>
                <td className="px-4 py-3">
                  <Badge variant={STATUS_VARIANT[c.status] ?? "unknown"}>{c.status}</Badge>
                </td>
                <td className="px-4 py-3">
                  {c.health && <Badge variant={HEALTH_VARIANT[c.health] ?? "unknown"}>{c.health}</Badge>}
                </td>
                <td className="px-4 py-3">{c.restart_count}</td>
                <td className="px-4 py-3">
                  {c.vulnerability_count > 0 ? (
                    <span>
                      {c.vulnerability_count}
                      {c.critical_vulnerability_count > 0 && (
                        <Badge variant="critical" className="ml-2">
                          {c.critical_vulnerability_count} critical
                        </Badge>
                      )}
                    </span>
                  ) : (
                    "0"
                  )}
                </td>
                {hasRole("admin") && (
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === `${c.name}:start` || c.status === "running"}
                        onClick={() => runAction(c.name, "start")}
                      >
                        {busy === `${c.name}:start` ? "..." : "Start"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === `${c.name}:stop` || c.status !== "running"}
                        onClick={() => runAction(c.name, "stop")}
                      >
                        {busy === `${c.name}:stop` ? "..." : "Stop"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === `${c.name}:restart`}
                        onClick={() => runAction(c.name, "restart")}
                      >
                        {busy === `${c.name}:restart` ? "..." : "Restart"}
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pageCount} ({filtered.length} containers)
          </span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmBulk !== null} onOpenChange={(open) => !open && setConfirmBulk(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmBulk === "stop" ? "Stop" : "Restart"} {selected.size} container(s)?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will {confirmBulk} every selected container on {hostname}. Selected:{" "}
            {Array.from(selected).join(", ")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulk(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => confirmBulk && runBulk(confirmBulk)}>
              {confirmBulk === "stop" ? "Stop containers" : "Restart containers"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
