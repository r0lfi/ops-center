import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type AIProvider } from "@/lib/api";

export function ProviderKeyDialog({ provider, onSaved }: { provider: AIProvider; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [model, setModel] = useState(provider.default_model ?? "");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function save() {
    setSaving(true);
    try {
      if (apiKey.trim()) await api.ai.providers.setKey(provider.id, apiKey.trim());
      await api.ai.providers.update(provider.id, {
        base_url: baseUrl.trim() || undefined,
        default_model: model.trim() || undefined,
        enabled: true,
      });
      onSaved();
      setOpen(false);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound className="h-3.5 w-3.5" />
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider.display_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {provider.kind !== "ollama" && (
            <div className="space-y-1">
              <Label>API key {provider.has_key && <span className="text-muted-foreground">(already set - leave blank to keep)</span>}</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
            </div>
          )}
          {provider.kind === "ollama" && (
            <div className="space-y-1">
              <Label>Base URL</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.0.2.10:11434" />
            </div>
          )}
          <div className="space-y-1">
            <Label>Default model</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
