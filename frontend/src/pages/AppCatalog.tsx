import { useCallback, useEffect, useMemo, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api, type AppTemplate, type DockerHost, type RenderedTemplate } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TEXTAREA_CLASS =
  "flex min-h-[16rem] w-full rounded-md border border-input bg-secondary px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function TemplateSettings({ onChanged }: { onChanged: () => void }) {
  const [templateUrl, setTemplateUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.appCatalog.settings().then((s) => setTemplateUrl(s.template_url));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const s = await api.appCatalog.updateSettings(draft);
      setTemplateUrl(s.template_url);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Template source: <span className="font-mono">{templateUrl || "loading..."}</span>
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDraft(templateUrl);
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        className="max-w-xl font-mono text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="https://.../templates.json"
      />
      <Button size="sm" disabled={saving} onClick={save}>
        {saving ? "Saving..." : "Save"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <p className="text-sm text-status-critical">{error}</p>}
    </div>
  );
}

function DeployTemplateDialog({ template, onClose }: { template: AppTemplate; onClose: () => void }) {
  const [hosts, setHosts] = useState<DockerHost[]>([]);
  const [hostname, setHostname] = useState("");
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.env.map((f) => [f.name, f.default ?? ""])),
  );
  const [step, setStep] = useState<"form" | "preview">("form");
  const [rendered, setRendered] = useState<RenderedTemplate | null>(null);
  const [composeYaml, setComposeYaml] = useState("");
  const [stackName, setStackName] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [rendering, setRendering] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<{ ok: boolean; stdout: string; stderr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dockerHosts.list().then((rows) => {
      setHosts(rows);
      if (rows.length > 0) setHostname(rows[0].hostname);
    });
  }, []);

  async function preview() {
    setRendering(true);
    setError(null);
    try {
      const res = await api.appCatalog.render(template.id, envValues);
      setRendered(res);
      setComposeYaml(res.compose_yaml);
      setStackName(res.suggested_name);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to render template");
    } finally {
      setRendering(false);
    }
  }

  async function deploy() {
    if (confirmText !== stackName) return;
    setDeploying(true);
    setError(null);
    setDeployResult(null);
    try {
      const res = await api.stacks.deploy(hostname, stackName, composeYaml);
      setDeployResult(res);
      if (res.ok) {
        setTimeout(onClose, 1200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to deploy stack");
    } finally {
      setDeploying(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy {template.title}</DialogTitle>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-4">
            {template.description && <p className="text-sm text-muted-foreground">{template.description}</p>}
            {template.note && (
              <p className="rounded-md border border-border bg-secondary p-2 text-xs text-muted-foreground">
                {template.note}
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="template-host">Host</Label>
              <Select id="template-host" value={hostname} onChange={(e) => setHostname(e.target.value)}>
                {hosts.map((h) => (
                  <option key={h.hostname} value={h.hostname}>
                    {h.hostname}
                  </option>
                ))}
              </Select>
            </div>

            {template.env.map((field) => (
              <div key={field.name} className="space-y-1.5">
                <Label htmlFor={`env-${field.name}`}>{field.label}</Label>
                {field.select ? (
                  <Select
                    id={`env-${field.name}`}
                    value={envValues[field.name] ?? ""}
                    onChange={(e) => setEnvValues({ ...envValues, [field.name]: e.target.value })}
                  >
                    {field.select.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.text}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`env-${field.name}`}
                    value={envValues[field.name] ?? ""}
                    onChange={(e) => setEnvValues({ ...envValues, [field.name]: e.target.value })}
                  />
                )}
                {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
              </div>
            ))}

            {error && <p className="text-sm text-status-critical">{error}</p>}
            <DialogFooter>
              <Button disabled={rendering || !hostname} onClick={preview}>
                {rendering ? "Rendering..." : "Preview compose file"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "preview" && rendered && (
          <div className="space-y-4">
            <p className="text-sm text-status-warning">
              Review before deploying - community templates sometimes hardcode host paths or reference a
              variable that isn't declared above. Deploying runs whatever this compose file says on{" "}
              {hostname}, equivalent to root on that host.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="template-stack-name">Stack name</Label>
              <Input
                id="template-stack-name"
                value={stackName}
                onChange={(e) => setStackName(e.target.value)}
                pattern="^[a-z0-9][a-z0-9_-]*$"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-compose">compose.yml</Label>
              <textarea
                id="template-compose"
                className={TEXTAREA_CLASS}
                value={composeYaml}
                onChange={(e) => setComposeYaml(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-confirm">Type the stack name to confirm</Label>
              <Input id="template-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </div>
            {deployResult && (
              <div className="space-y-1 rounded-md border border-border bg-secondary p-2">
                <p className={deployResult.ok ? "text-sm text-status-ok" : "text-sm text-destructive"}>
                  {deployResult.ok ? "Deployed." : "Failed."}
                </p>
                {deployResult.stdout && <pre className="max-h-40 overflow-y-auto text-xs">{deployResult.stdout}</pre>}
                {deployResult.stderr && (
                  <pre className="max-h-40 overflow-y-auto text-xs text-destructive">{deployResult.stderr}</pre>
                )}
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                Back
              </Button>
              <Button disabled={confirmText !== stackName || deploying} onClick={deploy}>
                {deploying ? "Deploying..." : "Deploy"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AppCatalog() {
  const { hasRole } = useAuth();
  const [templates, setTemplates] = useState<AppTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<AppTemplate | null>(null);
  const [brokenLogos, setBrokenLogos] = useState<Set<number>>(new Set());

  const refresh = useCallback(() => {
    setTemplates(null);
    setError(null);
    api.appCatalog
      .templates()
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load app catalog"));
  }, []);

  useEffect(refresh, [refresh]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    (templates ?? []).forEach((t) => t.categories.forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }, [templates]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (templates ?? []).filter((t) => {
      if (category && !t.categories.includes(category)) return false;
      if (!q) return true;
      return t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [templates, search, category]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">App Catalog</h1>
          <p className="text-sm text-muted-foreground">
            Pick a pre-built app, fill in a few settings, review the resulting compose file, and deploy it
            as a stack.
          </p>
        </div>
      </div>

      {hasRole("admin") && <TemplateSettings onChanged={refresh} />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search apps..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select className="max-w-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>

      {error && <p className="text-sm text-status-critical">{error}</p>}
      {templates === null && !error && <p className="text-sm text-muted-foreground">Loading...</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filtered.map((t) => (
          <Card
            key={t.id}
            className="cursor-pointer transition-colors hover:border-primary"
            onClick={() => setSelected(t)}
          >
            <CardContent className="space-y-2 py-4">
              <div className="flex items-center gap-3">
                {t.logo && !brokenLogos.has(t.id) ? (
                  <img
                    src={t.logo}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded object-contain"
                    onError={() => setBrokenLogos((prev) => new Set(prev).add(t.id))}
                  />
                ) : (
                  <div className="h-8 w-8 shrink-0 rounded bg-secondary" />
                )}
                <span className="font-medium">{t.title}</span>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
              <div className="flex flex-wrap gap-1">
                {t.categories.slice(0, 3).map((c) => (
                  <Badge key={c} variant="secondary">
                    {c}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {templates !== null && filtered.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No apps match this search.</p>
      )}

      {selected && <DeployTemplateDialog template={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
