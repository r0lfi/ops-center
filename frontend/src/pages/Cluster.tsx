import { useEffect, useState } from "react";
import { ArrowLeftRight, Crown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import {
  api,
  type ClusterStatus,
  type PatroniNodeStatus,
  type RedisNodeStatus,
  type RedisStatus,
} from "@/lib/api";

const ROLE_VARIANT: Record<string, "ok" | "warning" | "critical" | "unknown"> = {
  primary: "ok",
  replica: "unknown",
  master: "ok",
  slave: "unknown",
};

const ARCHITECTURE_REFERENCE: { component: string; detail: string; status?: "ok" | "warning" | "unknown" }[] = [
  { component: "Deployment", detail: "The installer deploys one server. Patroni and Sentinel status requires an independently configured HA cluster.", status: "unknown" },
];

function PatroniNodeCard({ node, vip, vipHolder }: { node: PatroniNodeStatus; vip: string; vipHolder: string | null }) {
  const holdsVip = node.name !== null && node.name === vipHolder;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            {node.name ?? node.host}
            {holdsVip && <Crown className="h-4 w-4 text-status-ok" />}
          </span>
          <Badge variant={node.reachable ? (ROLE_VARIANT[node.role ?? ""] ?? "unknown") : "critical"}>
            {node.reachable ? (node.role ?? "unknown") : "unreachable"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Host</span>
          <span>{node.host}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Patroni state</span>
          <span>{node.state ?? "-"}</span>
        </div>
        {node.role === "replica" && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Replication</span>
            <span>{node.replication_state ?? "-"}</span>
          </div>
        )}
        {node.role === "primary" && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Timeline</span>
            <span>{node.timeline ?? "-"}</span>
          </div>
        )}
        {holdsVip && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">VIP</span>
            <span className="font-mono">{vip}</span>
          </div>
        )}
        {node.replicas && node.replicas.length > 0 && (
          <div className="border-t border-border pt-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Replicas</p>
            {node.replicas.map((r, i) => (
              <div key={i} className="flex justify-between text-xs">
                <span>{String(r.application_name)}</span>
                <span className="text-muted-foreground">
                  {String(r.state)} / {String(r.sync_state)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RedisNodeCard({ node }: { node: RedisNodeStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{node.host}</span>
          <Badge variant={node.reachable ? (ROLE_VARIANT[node.role ?? ""] ?? "unknown") : "critical"}>
            {node.reachable ? (node.role ?? "unknown") : "unreachable"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {node.role === "master" && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Connected replicas</span>
            <span>{node.connected_slaves ?? "-"}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SentinelCard({ redis }: { redis: RedisStatus }) {
  const masterHosts = new Set(redis.sentinels.filter((s) => s.reachable).map((s) => s.master_host));
  const allAgree = redis.sentinels.every((s) => s.reachable) && masterHosts.size === 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>Sentinel quorum</span>
          <Badge variant={allAgree ? "ok" : "warning"}>{allAgree ? "agree" : "check"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {redis.sentinels.map((s) => (
          <div key={s.host} className="flex justify-between">
            <span className="text-muted-foreground">{s.host}</span>
            <span>{s.reachable ? `sees master @ ${s.master_host}` : "unreachable"}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function Cluster() {
  const { hasRole } = useAuth();
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    function refresh() {
      api.cluster.status().then(setStatus).catch(() => setStatus(null));
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  async function handleSwitchover() {
    if (!status) return;
    const leader = status.postgres.nodes.find((n) => n.role === "primary");
    if (!confirm(`Trigger a Postgres switchover away from "${leader?.name ?? "the current leader"}"?`)) return;
    setSwitching(true);
    try {
      await api.cluster.switchover();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Cluster</h1>
          <p className="text-sm text-muted-foreground">
            Status for optional Patroni and Redis services. The standard installation runs on one server.
          </p>
        </div>
        {hasRole("admin") && (
          <Button variant="outline" onClick={handleSwitchover} disabled={switching || !status || status.postgres.nodes.length === 0}>
            <ArrowLeftRight className="h-4 w-4" />
            {switching ? "Switching over..." : "Trigger switchover"}
          </Button>
        )}
      </div>

      {!status && <p className="text-sm text-status-warning">Cluster status is unavailable right now.</p>}

      {status && (
        <>
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Postgres <span className="font-mono normal-case">({status.postgres.scope})</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {status.postgres.nodes.map((node) => (
                <PatroniNodeCard
                  key={node.host}
                  node={node}
                  vip={status.postgres.vip}
                  vipHolder={status.postgres.vip_holder}
                />
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Redis <span className="font-mono normal-case">({status.redis.master_name})</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {status.redis.nodes.map((node) => (
                <RedisNodeCard key={node.host} node={node} />
              ))}
              <SentinelCard redis={status.redis} />
            </div>
          </div>
        </>
      )}

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
                              (row.status === "ok" ? "bg-status-ok" : "bg-status-unknown")
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
    </div>
  );
}
