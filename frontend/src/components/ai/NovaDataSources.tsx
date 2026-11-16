import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type DataSourceTest, type NovaDataSources as SourcesState } from "@/lib/api";

export function NovaDataSources() {
  const [state, setState] = useState<SourcesState | null>(null);
  const [test, setTest] = useState<DataSourceTest | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.ai.routines.sources().then(setState).catch((err) => setMessage(String(err))); }, []);

  async function runTest() {
    setBusy(true); setMessage("");
    try { setTest(await api.ai.routines.testSources()); } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Data sources</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm" data-sources>
        <p className="text-muted-foreground">
          Nova can read your calendar, tasks and home status, in chat and in routines. It only reads; it cannot change anything.
          Sources are set up by an administrator (NOVA_DATA_SOURCES and a credential file on the server) and only your own tasks can use them.
        </p>
        {!state && <p className="text-muted-foreground">{message || "Loading…"}</p>}
        {state && state.sources.length === 0 && <p className="text-muted-foreground">No data sources are set up for you.</p>}
        {state?.sources.map((s) => {
          const result = test?.results.find((r) => r.kind === s.kind);
          return (
            <div key={s.kind} className="min-w-0 space-y-1 rounded-md border border-border p-3" data-source={s.kind}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.label}</span>
                {s.host && <span className="text-muted-foreground [overflow-wrap:anywhere]">{s.host}</span>}
                {!s.secret_present && <Badge variant="critical">credential missing</Badge>}
                {!s.offered && <Badge variant="warning">off while Nova uses a cloud provider</Badge>}
                {result && <Badge variant={result.ok ? "ok" : "critical"}>{result.ok ? "connected" : "failed"}</Badge>}
              </p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {s.kind === "caldav"
                  ? `Calendars: ${s.calendars.join(", ") || "none"} · Task lists: ${s.task_lists.join(", ") || "none"}`
                  : `Entities: ${s.entities.join(", ")}`}
              </p>
              {result?.error && <p role="alert" className="text-xs text-status-critical">{result.error}</p>}
            </div>
          );
        })}
        {state && state.sources.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void runTest()}>Test connection</Button>}
        {state?.cloud_provider && state.sources.some((s) => s.offered) && (
          <p role="alert" className="text-xs text-status-warning">Nova uses a cloud provider: calendar or home data you allowed for cloud use is sent to it.</p>
        )}
        {message && state && <p role="status" className="text-status-critical">{message}</p>}
      </CardContent>
    </Card>
  );
}
