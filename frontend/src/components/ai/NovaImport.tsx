import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ImportEstimate, type ImportKind, type ImportSource, type ImportStatus, type ImportSummary } from "@/lib/api";
import { formatNumber } from "@/lib/format";

const SOURCES: { value: ImportSource; label: string }[] = [
  { value: "chatgpt", label: "ChatGPT" }, { value: "claude", label: "Claude" }, { value: "gemini", label: "Gemini" }, { value: "other", label: "Other assistant" },
];
const selectClass = "rounded-md border border-input bg-secondary px-3 py-2 text-sm";

function SummaryView({ summary }: { summary: ImportSummary }) {
  const rows: [string, number | undefined][] = summary.kind === "memory_list"
    ? [["Items found", summary.items], ["New suggestions", summary.new_suggestions], ["Already suggested earlier", summary.already_suggested],
       ["Removed: look like credentials", summary.filtered_secrets], ["Duplicates", summary.duplicates], ["Too short", summary.skipped_short]]
    : [["Conversations", summary.conversations], ["New", summary.new], ["Changed", summary.updated], ["Unchanged", summary.unchanged],
       ["Removed lines: look like credentials", summary.filtered_secret_lines], ["Empty, skipped", summary.skipped_empty], ["Other files ignored", summary.ignored_files]];
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-import-summary={summary.kind}>
      <p className="font-medium">{summary.imported ? "Imported" : "Preview: nothing has been saved yet"}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="text-right tabular-nums">{value ?? 0}</dd></div>)}
      </dl>
      {summary.kind === "chatgpt_export" && <p className="text-xs text-muted-foreground">user.json is recognized but never stored.</p>}
      {summary.sample.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{summary.sample.map((s) => <li key={s} className="break-words">{s}</li>)}</ul>}
    </div>
  );
}

function useUpload(kind: ImportKind, onImported: () => void) {
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(apply: boolean, source: ImportSource, file: Blob, name: string) {
    setBusy(true); setError("");
    try {
      const result = apply ? await api.ai.imports.apply(kind, source, file, name) : await api.ai.imports.preview(kind, source, file, name);
      setSummary(result);
      if (apply) onImported();
    } catch (err) {
      setSummary(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { summary, setSummary, error, busy, run };
}

function MemoryListImport({ disabled, onImported }: { disabled: boolean; onImported: () => void }) {
  const [source, setSource] = useState<ImportSource>("chatgpt");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const upload = useUpload("memory_list", onImported);
  const blob = file ?? (text.trim() ? new Blob([text], { type: "text/plain" }) : null);
  const name = file?.name ?? "pasted-memory.txt";
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Memory list</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          In ChatGPT open Settings → Personalization → Memory and copy the list, or ask the assistant to list everything it remembers about you.
          Claude, Gemini and other assistants work the same way. Each item becomes a suggestion you accept or reject; nothing is saved as a note directly.
        </p>
        <label className="block space-y-1"><span>Remembered by</span>
          <select aria-label="Memory list source" className={`block w-full ${selectClass}`} value={source} onChange={(e) => { setSource(e.target.value as ImportSource); upload.setSummary(null); }}>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <input aria-label="Memory list file" type="file" accept=".txt,.md,text/plain,text/markdown" className="block w-full text-sm"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); upload.setSummary(null); }} />
        <textarea aria-label="Paste memory list" className="min-h-28 w-full rounded-md border border-input bg-secondary p-2 text-sm" disabled={!!file}
          placeholder="…or paste the list here" value={text} maxLength={200000} onChange={(e) => { setText(e.target.value); upload.setSummary(null); }} />
        {upload.error && <p role="alert" className="text-destructive">{upload.error}</p>}
        {upload.summary && <SummaryView summary={upload.summary} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!blob || upload.busy} onClick={() => blob && void upload.run(false, source, blob, name)}>Preview</Button>
          <Button disabled={!blob || upload.busy || disabled || !upload.summary || upload.summary.imported || !upload.summary.new_suggestions}
            onClick={() => blob && void upload.run(true, source, blob, name)}>Import as suggestions</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EstimateView({ estimate }: { estimate: ImportEstimate }) {
  const cost = estimate.local ? `runs on ${estimate.provider}, no API cost` : estimate.cost_usd !== null ? `about $${estimate.cost_usd.toFixed(2)} on ${estimate.provider}` : estimate.note ?? "cost unknown";
  return (
    <p className="rounded-md border border-border p-3 text-sm" data-import-estimate>
      {estimate.conversations} conversations in {estimate.model_calls} model calls, about {formatNumber(estimate.input_tokens)} input and
      {" "}{formatNumber(estimate.output_tokens)} output tokens: {cost}. Paid calls count against the weekly AI budget.
    </p>
  );
}

function ExportImport({ status, disabled, onImported }: { status: ImportStatus | null; disabled: boolean; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [estimate, setEstimate] = useState<ImportEstimate | null>(null);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");
  const upload = useUpload("chatgpt_export", onImported);
  async function guarded(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">ChatGPT data export</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          In ChatGPT open Settings → Data controls → Export data and upload the zip you receive (up to {status?.max_upload_mb ?? 200} MB).
          Its conversations become an archive only Nova searches; the zip itself is not kept.
        </p>
        <input aria-label="ChatGPT export file" type="file" accept=".zip,application/zip" className="block w-full text-sm"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); upload.setSummary(null); }} />
        {upload.error && <p role="alert" className="text-destructive">{upload.error}</p>}
        {upload.summary && <SummaryView summary={upload.summary} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!file || upload.busy} onClick={() => file && void upload.run(false, "chatgpt", file, file.name)}>{upload.busy ? "Reading…" : "Preview"}</Button>
          <Button disabled={!file || upload.busy || disabled || !upload.summary || upload.summary.imported || !(upload.summary.new || upload.summary.updated)}
            onClick={() => file && void upload.run(true, "chatgpt", file, file.name)}>Import archive</Button>
        </div>
        <div className="space-y-2 border-t border-border pt-3">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Archive</span>
            <Badge variant="outline">{status?.conversations ?? 0} conversations</Badge>
            <Badge variant="outline">{status?.analyzed ?? 0} analyzed</Badge>
          </p>
          <p className="text-muted-foreground">Optionally let Nova read the archive and suggest facts about you. Check the estimate first.</p>
          {estimate && <EstimateView estimate={estimate} />}
          {queued && <p role="status">Started. New suggestions appear under Suggestions as Nova works through the archive.</p>}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!status?.conversations} onClick={() => void guarded(async () => { setQueued(false); setEstimate(await api.ai.imports.estimate()); })}>Estimate</Button>
            <Button disabled={disabled || !estimate || !estimate.conversations || queued} onClick={() => void guarded(async () => { await api.ai.imports.suggest(); setQueued(true); })}>
              Confirm and suggest facts
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DeleteImports({ onDeleted }: { onDeleted: () => void }) {
  const [source, setSource] = useState<ImportSource>("chatgpt");
  const [result, setResult] = useState("");
  const label = SOURCES.find((s) => s.value === source)?.label ?? source;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Delete imported data</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Imported data source" className={selectClass} value={source} onChange={(e) => { setSource(e.target.value as ImportSource); setResult(""); }}>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <Button variant="outline" className="border-status-critical/50 text-status-critical" onClick={() => {
          if (!window.confirm(`Delete everything imported from ${label}: the conversation archive, all its suggestions and the notes you accepted from it?`)) return;
          void api.ai.imports.remove(source).then((r) => { setResult(`Deleted ${r.deleted_conversations} conversations, ${r.deleted_suggestions} suggestions and ${r.deleted_notes} notes.`); onDeleted(); })
            .catch((err) => setResult(String(err)));
        }}>Delete all imported {label} data</Button>
        {result && <p role="status" className="w-full text-muted-foreground">{result}</p>}
      </CardContent>
    </Card>
  );
}

export function NovaImport({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    api.ai.imports.status().then((s) => { if (live) setStatus(s); }).catch((err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [refresh]);
  const changed = () => { setRefresh((v) => v + 1); onChanged(); };
  const disabled = status?.memory_enabled === false;
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {disabled && <p role="alert" className="text-sm text-status-warning">Long-term memory is off. You can preview files, but importing needs memory turned on.</p>}
      <p className="text-sm text-muted-foreground">Imports only read your files; nothing is sent back to the other assistant. Lines that look like credentials are removed, and importing the same file again adds nothing twice.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <MemoryListImport disabled={disabled} onImported={changed} />
        <ExportImport status={status} disabled={disabled} onImported={changed} />
      </div>
      <DeleteImports onDeleted={changed} />
    </div>
  );
}
