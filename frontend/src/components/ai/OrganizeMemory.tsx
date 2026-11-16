import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KindSelect, ScopeSelect, type Scope } from "@/components/ai/MemoryOverview";
import { api, OrganizeApplyError, type MemoryKind, type OrganizeJob, type OrganizeProposal } from "@/lib/api";

const POLL_MS = 3000;
const ACTION_LABEL = { create: "New", update: "Updates an existing note", unchanged: "Already known" } as const;

interface Draft {
  id: string; include: boolean; selected: boolean; key: string; category: string; kind: MemoryKind; scope: Scope; content: string;
  proposal: OrganizeProposal;
}

function toDraft(p: OrganizeProposal): Draft {
  return { id: p.id, include: p.action !== "unchanged", selected: false, key: p.key, category: p.category ?? "", kind: p.kind,
           scope: p.scope, content: p.content, proposal: p };
}

function ProposalCard({ draft, error, onChange, onRemove }: { draft: Draft; error?: string; onChange: (d: Draft) => void; onRemove: () => void }) {
  const p = draft.proposal;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <div className={`min-w-0 space-y-2 rounded-md border p-3 ${error ? "border-status-critical" : "border-border"} ${draft.include ? "" : "opacity-60"}`} data-proposal={draft.key}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1 font-medium"><input type="checkbox" aria-label={`Save ${draft.key}`} checked={draft.include} onChange={(e) => set({ include: e.target.checked })} />Save</label>
        <Badge variant={p.action === "create" ? "ok" : p.action === "update" ? "warning" : "outline"}>{ACTION_LABEL[p.action]}</Badge>
        {p.reason && p.action !== "create" && <span className="text-muted-foreground">({p.reason})</span>}
        <label className="ml-auto flex items-center gap-1"><input type="checkbox" aria-label={`Select ${draft.key} to merge`} checked={draft.selected} onChange={(e) => set({ selected: e.target.checked })} />Select</label>
        <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      {error && <p role="alert" className="text-xs text-status-critical">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Proposed key" value={draft.key} maxLength={100} pattern="[a-zA-Z0-9_.-]+" onChange={(e) => set({ key: e.target.value })} />
        <Input aria-label="Proposed category" list="memory-categories" value={draft.category} maxLength={80} onChange={(e) => set({ category: e.target.value })} />
        <div className="space-y-1">
          <ScopeSelect label="Proposed scope" value={draft.scope} onChange={(scope) => set({ scope })} />
          {p.suggested_scope !== draft.scope && p.action === "create" && (
            <p className="text-xs text-muted-foreground">
              Nova suggests {p.suggested_scope === "shared" ? "Shared" : "Nova only"}.{" "}
              <button type="button" className="text-primary hover:underline" onClick={() => set({ scope: p.suggested_scope })}>Use it</button>
            </p>
          )}
        </div>
        <KindSelect label="Proposed kind" value={draft.kind} onChange={(kind) => set({ kind })} />
      </div>
      <textarea aria-label="Proposed content" className="min-h-28 w-full rounded-md border border-input bg-secondary p-2 text-sm" maxLength={8000} value={draft.content}
        onChange={(e) => set({ content: e.target.value })} />
      {p.target && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Current text of <span className="font-mono [overflow-wrap:anywhere]">{p.target.key}</span> ({p.target.scope === "nova" ? "Nova only" : "Shared"})</summary>
          <p className="mt-1 whitespace-pre-wrap break-words rounded bg-accent/50 p-2">{p.target.content}</p>
        </details>
      )}
    </div>
  );
}

export function OrganizeMemory({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<OrganizeJob | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((next: OrganizeJob) => {
    setJob(next);
    if (next.proposals && !["queued", "running"].includes(next.status)) setDrafts(next.proposals.map(toDraft));
  }, []);
  useEffect(() => {
    let live = true;
    api.ai.memory.organize.list().then(async (r) => {
      const open = r.items[0];
      if (live && open) load(await api.ai.memory.organize.get(open.id));
    }).catch(() => {});
    return () => { live = false; };
  }, [load]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = setTimeout(() => { api.ai.memory.organize.get(job.id).then(load).catch((err) => setMessage(String(err))); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, load]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  const start = () => run(async () => { setDrafts([]); setErrors({}); load(await api.ai.memory.organize.start(file ? { file } : { text })); });
  const save = () => run(async () => {
    if (!job) return;
    setErrors({});
    const items = drafts.map((d) => ({
      action: !d.include ? "skip" as const : d.proposal.action === "update" && d.proposal.target ? "update" as const : "create" as const,
      key: d.key.trim(), content: d.content.trim(), category: d.category.trim() || null, kind: d.kind, scope: d.scope,
      target_id: d.proposal.action === "update" ? d.proposal.target?.id ?? null : null,
    }));
    try {
      const result = await api.ai.memory.organize.apply(job.id, items);
      setJob(null); setDrafts([]); setText(""); setFile(null);
      setMessage(`Saved: ${result.created} new, ${result.updated} updated, ${result.skipped} skipped.`);
      onSaved();
    } catch (err) {
      if (err instanceof OrganizeApplyError) setErrors(Object.fromEntries(err.errors.map((e) => [drafts[e.index]?.id, e.error])));
      throw err;
    }
  });
  function mergeSelected() {
    const chosen = drafts.filter((d) => d.selected);
    if (chosen.length < 2) return;
    const [first, ...rest] = chosen;
    const merged = { ...first, selected: false, include: true, content: chosen.map((d) => d.content).join("\n\n") };
    setDrafts(drafts.filter((d) => !rest.includes(d)).map((d) => (d.id === first.id ? merged : d)));
  }

  const running = job && ["queued", "running"].includes(job.status);
  const done = job?.sections.filter((s) => s.status === "done").length ?? 0;
  const failed = job?.sections.filter((s) => s.status === "failed") ?? [];
  const secrets = job?.sections.reduce((sum, s) => sum + (s.secrets ?? 0), 0) ?? 0;
  const counts = { create: 0, update: 0, unchanged: 0 };
  drafts.forEach((d) => { counts[d.proposal.action] += 1; });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Import &amp; Organize</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!job && (
          <>
            <p className="text-muted-foreground">
              Paste a long text about yourself, your infrastructure, projects and how agents should work, or upload a .txt/.md profile file.
              Nova splits it into separate memories with keys, categories and scope and compares them with what it already knows.
              Nothing is saved until you review the proposals and choose Save All. You can upload an updated profile later; unchanged parts are recognized.
            </p>
            <textarea aria-label="Text to organize" className="min-h-48 w-full rounded-md border border-input bg-secondary p-2 text-sm" disabled={!!file} maxLength={1000000}
              placeholder="Paste your profile here…" value={text} onChange={(e) => setText(e.target.value)} />
            <input aria-label="Profile file" type="file" accept=".txt,.md,text/plain,text/markdown" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <Button disabled={busy || (!file && !text.trim())} onClick={() => void start()}>Analyze &amp; Organize</Button>
          </>
        )}
        {job && (
          <div className="space-y-2" data-organize-status={job.status}>
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium [overflow-wrap:anywhere]">{job.source_name}</span>
              <Badge variant={job.status === "failed" ? "critical" : job.status === "partial" ? "warning" : running ? "outline" : "ok"}>{job.status}</Badge>
              <span className="text-muted-foreground">{done} of {job.sections.length} sections analyzed</span>
            </p>
            {running && <p className="text-muted-foreground">Nova is reading the text. A local model can take a few minutes; you can leave this page and come back.</p>}
            {secrets > 0 && <p className="text-xs text-status-warning">{secrets} line(s) that looked like credentials were removed before analysis.</p>}
            {failed.map((s) => <p key={s.index} role="alert" className="text-xs text-status-critical">Section {s.index + 1} failed: {s.error}</p>)}
            <div className="flex flex-wrap gap-2">
              {failed.length > 0 && !running && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => load(await api.ai.memory.organize.retry(job.id)))}>Retry failed sections</Button>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
                if (!window.confirm("Discard this analysis? Nothing from it has been saved.")) return;
                await api.ai.memory.organize.discard(job.id); setJob(null); setDrafts([]);
              })}>Discard</Button>
            </div>
          </div>
        )}
        {drafts.length > 0 && !running && (
          <div className="space-y-2">
            <p className="text-muted-foreground">{counts.create} new, {counts.update} updates, {counts.unchanged} already known. New memories are Nova only unless you choose Shared.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={drafts.filter((d) => d.selected).length < 2} onClick={mergeSelected}>Merge selected</Button>
            </div>
            {drafts.map((d) => <ProposalCard key={d.id} draft={d} error={errors[d.id]} onChange={(next) => setDrafts(drafts.map((x) => (x.id === d.id ? next : x)))}
              onRemove={() => setDrafts(drafts.filter((x) => x.id !== d.id))} />)}
            <Button disabled={busy || !drafts.some((d) => d.include)} onClick={() => void save()}>Save All ({drafts.filter((d) => d.include).length})</Button>
          </div>
        )}
        {message && <p role="status" className={Object.keys(errors).length ? "text-status-critical" : "text-muted-foreground"}>{message}</p>}
      </CardContent>
    </Card>
  );
}
