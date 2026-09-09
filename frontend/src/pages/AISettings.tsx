import { useEffect, useState } from "react";

import { ProviderKeyDialog } from "@/components/ai/ProviderKeyDialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { api, type AIProvider } from "@/lib/api";

export default function AISettings() {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const [providers, setProviders] = useState<AIProvider[]>([]);

  function refresh() {
    api.ai.providers.list().then(setProviders).catch(() => {});
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI Providers</CardTitle>
          <p className="text-xs text-muted-foreground">API keys and default models - stored server-side, never shown again once set.</p>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {providers.map((p) => (
            <div key={p.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.display_name}</span>
                <Badge variant={p.enabled ? "ok" : "unknown"}>{p.enabled ? "enabled" : "disabled"}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {p.default_model || "no default model set"}
                {p.kind !== "ollama" && <> - key {p.has_key ? "configured" : "not set"}</>}
              </p>
              {isAdmin && <ProviderKeyDialog provider={p} onSaved={refresh} />}
            </div>
          ))}
          {!isAdmin && <p className="text-sm text-muted-foreground">Admin role required to change provider settings.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
