import { useCallback, useEffect, useState } from "react";

import { useReauth } from "@/components/ReauthDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type UserSessionInfo } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

function device(agent: string | null): string {
  if (!agent) return "Unknown device";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Signed-in browsers of every user. Revoking ends the session at once (it needs a fresh password). */
export function SessionsPanel() {
  const withReauth = useReauth();
  const [rows, setRows] = useState<UserSessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.auth.sessions(true).then(data => { setRows(data); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : "Failed to load sessions"));
  }, []);
  useEffect(load, [load]);

  async function revoke(row: UserSessionInfo) {
    setBusy(row.id);
    try {
      await withReauth(() => api.auth.revokeSession(row.user_id, row.id));
      load();
    } catch { /* Cancelled or shown by the central error toast. */ } finally { setBusy(null); }
  }

  async function revokeAll(userId: string) {
    setBusy(userId);
    try {
      await withReauth(() => api.auth.revokeAllSessions(userId));
      load();
    } catch { /* As above. */ } finally { setBusy(null); }
  }

  const users = [...new Set((rows ?? []).map(r => r.user_id))];
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <p className="text-sm text-muted-foreground">Signed-in browsers. Revoking signs that browser out on its next request; it needs your password again.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p role="alert" className="text-sm text-status-critical">{error}</p>}
        {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {rows?.length === 0 && <p className="text-sm text-muted-foreground">No active sessions.</p>}
        {users.map(userId => {
          const sessions = rows!.filter(r => r.user_id === userId);
          return (
            <div key={userId} className="rounded-lg border border-border/60">
              <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
                <span className="text-sm font-medium">{sessions[0].username}</span>
                {sessions.length > 1 && <Button size="sm" variant="outline" disabled={busy === userId} onClick={() => revokeAll(userId)}>Sign out everywhere</Button>}
              </div>
              <ul className="divide-y divide-border/50">
                {sessions.map(row => (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{device(row.user_agent)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{row.ip ?? "unknown address"}</span>
                      <span className="block text-xs text-muted-foreground">
                        Signed in {formatDateTime(row.created_at)} · last active {formatDateTime(row.last_used_at)} · ends by {formatDateTime(row.idle_expires_at)} if idle
                      </span>
                    </span>
                    {row.current && <Badge variant="ok">This browser</Badge>}
                    {row.remember && <Badge variant="unknown">Remembered</Badge>}
                    <Button size="sm" variant="destructive" disabled={busy === row.id} onClick={() => revoke(row)}>Revoke</Button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
