import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type AIProvider } from "@/lib/api";

const KEY_PLACEHOLDER: Record<string, string> = { anthropic: "sk-ant-...", mistral: "Mistral API key" };
const MODEL_PLACEHOLDER: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-luna",
  mistral: "mistral-large-4",
  ollama: "llama3.1",
};

export function ProviderKeyDialog({ provider, onSaved }: { provider: AIProvider; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.base_url ?? "");
  const [model, setModel] = useState(provider.default_model ?? "");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !open) {
      setBaseUrl(provider.base_url ?? "");
      setModel(provider.default_model ?? "");
      setEnabled(provider.enabled);
    }
    setApiKey("");
    setOpen(nextOpen);
  }

  async function save() {
    setSaving(true);
    try {
      if (apiKey.trim()) await api.ai.providers.setKey(provider.id, apiKey.trim());
      await api.ai.providers.update(provider.id, {
        base_url: baseUrl.trim() || undefined,
        default_model: model.trim() || undefined,
        ...(enabled !== provider.enabled ? { enabled } : {}),
      });
      onSaved();
      setOpen(false);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
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
              <Label htmlFor={`provider-key-${provider.id}`}>API key {provider.has_key && <span className="text-muted-foreground">(already set - leave blank to keep)</span>}</Label>
              <Input id={`provider-key-${provider.id}`} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={KEY_PLACEHOLDER[provider.kind] ?? "sk-..."} />
            </div>
          )}
          {(provider.kind === "ollama" || provider.kind === "openai_compatible") && (
            <div className="space-y-1">
              <Label htmlFor={`provider-url-${provider.id}`}>Base URL</Label>
              <Input id={`provider-url-${provider.id}`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={provider.kind === "ollama" ? "http://192.0.2.38:11434" : "https://llm.example.lan/v1"} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`provider-model-${provider.id}`}>Default model</Label>
            {provider.kind === "mistral" && (
              <p className="text-xs text-muted-foreground">Priced models: mistral-large-4, mistral-small-2603. Other Mistral models are blocked by the AI budget until their price is reviewed.</p>
            )}
            <Input id={`provider-model-${provider.id}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder={MODEL_PLACEHOLDER[provider.kind] ?? "model name"} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
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
