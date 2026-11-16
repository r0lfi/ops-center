import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type AIAgent, type MemoryKind, type MemoryVersion, type PersonalMemory } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

// Imported Claude Code notes are searchable by every agent but would flood this view.
const IMPORTED_PREFIX = "claude.";
const JOURNAL_PREFIX = "nova.journal.";
const UNCATEGORIZED = "Uncategorized";
const LONG = 600;
const fieldClass = "w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm";
const KIND_LABEL: Record<MemoryKind, string> = { fact: "Fact", plan: "Plan", history: "History" };

export type Scope = "nova" | "shared";
type Mutate = (action: () => Promise<unknown>) => Promise<boolean>;

function when(iso: string) {
  return formatDateTime(iso);
}

export function groupName(note: PersonalMemory) {
  return note.key.startsWith(JOURNAL_PREFIX) ? "Journal" : note.category || UNCATEGORIZED;
}

export function ScopeSelect({ value, onChange, label = "Scope" }: { value: Scope; onChange: (scope: Scope) => void; label?: string }) {
  return (
    <select aria-label={label} className={fieldClass} value={value} onChange={(e) => onChange(e.target.value as Scope)}>
      <option value="nova">Nova only</option>
      <option value="shared">Shared with all my agents</option>
    </select>
  );
}

export function KindSelect({ value, onChange, label = "Kind" }: { value: MemoryKind; onChange: (kind: MemoryKind) => void; label?: string }) {
  return (
    <select aria-label={label} className={fieldClass} value={value} onChange={(e) => onChange(e.target.value as MemoryKind)}>
      <option value="fact">Fact (current)</option>
      <option value="plan">Plan (intention)</option>
      <option value="history">History (no longer current)</option>
    </select>
  );
}

function NoteEditor({ note, agent, categories, busy, mutate, onDone }: {
  note: PersonalMemory | null; agent: AIAgent; categories: string[]; busy: boolean; mutate: Mutate; onDone: () => void;
}) {
  const [key, setKey] = useState(note?.key ?? "");
  const [category, setCategory] = useState(note?.category ?? "");
  const [scope, setScope] = useState<Scope>(note && !note.agent_id ? "shared" : "nova");
  const [kind, setKind] = useState<MemoryKind>(note?.kind ?? "fact");
  const [content, setContent] = useState(note?.content ?? "");
  async function save() {
    const agentId = scope === "nova" ? agent.id : null;
    const ok = await mutate(() => note
      ? api.ai.memory.update(note.id, { key: key.trim(), content: content.trim(), category: category.trim() || null, kind, agent_id: agentId })
      : api.ai.memory.save(key.trim(), content.trim(), agentId, { category: category.trim() || null, kind }));
    if (ok) onDone();
  }
  return (
    <form className="space-y-2 rounded-md border border-border p-3" onSubmit={(e) => { e.preventDefault(); void save(); }} data-note-editor>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="Memory key" placeholder="Key, e.g. career.current_employer" pattern="[a-zA-Z0-9_.-]+" maxLength={100} required value={key} onChange={(e) => setKey(e.target.value)} />
        <Input aria-label="Memory category" placeholder="Category, e.g. Career & Work" list="memory-categories" maxLength={80} value={category} onChange={(e) => setCategory(e.target.value)} />
        <ScopeSelect value={scope} onChange={setScope} />
        <KindSelect value={kind} onChange={setKind} />
      </div>
      <datalist id="memory-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      {scope === "shared" && <p className="text-xs text-status-warning">Shared notes are read by all your agents.</p>}
      <textarea aria-label="Memory content" className="min-h-40 w-full rounded-md border border-input bg-secondary p-2 text-sm" maxLength={8000} required
        placeholder="What should Nova remember?" value={content} onChange={(e) => setContent(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !key.trim() || !content.trim()}>{note ? "Save changes" : "Save note"}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function VersionList({ versions, busy, onRestore }: { versions: MemoryVersion[]; busy: boolean; onRestore: (v: MemoryVersion) => void }) {
  if (!versions.length) return <p className="text-sm text-muted-foreground">No earlier versions.</p>;
  return (
    <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
      {versions.map((v) => (
        <li key={v.id} className="space-y-1 rounded-md border border-border p-2 text-sm" data-version={v.id}>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-primary [overflow-wrap:anywhere]">{v.key}</span>
            <Badge variant="outline">{v.change === "delete" ? "deleted" : v.change === "merge" ? "merged" : `before ${v.change}`}</Badge>
            <span>{when(v.created_at)} · by {v.changed_by}</span>
          </p>
          <p className="whitespace-pre-wrap break-words">{v.content.length > LONG ? v.content.slice(0, LONG) + "…" : v.content}</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onRestore(v)}>Restore this version</Button>
        </li>
      ))}
    </ul>
  );
}

function NoteCard({ note, agent, duplicateOf, selected, busy, categories, mutate, onToggle, onHistory }: {
  note: PersonalMemory; agent: AIAgent; duplicateOf: PersonalMemory[]; selected: boolean; busy: boolean; categories: string[];
  mutate: Mutate; onToggle: () => void; onHistory: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (editing) return <NoteEditor note={note} agent={agent} categories={categories} busy={busy} mutate={mutate} onDone={() => setEditing(false)} />;
  const long = note.content.length > LONG;
  return (
    <div className="min-w-0 space-y-2 rounded-md border border-border p-3" data-note={note.key}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-xs text-primary [overflow-wrap:anywhere]">{note.key}</span>
        <Badge variant="outline">{note.agent_id ? "Nova only" : "Shared"}</Badge>
        {note.kind && note.kind !== "fact" && <Badge variant="outline">{KIND_LABEL[note.kind]}</Badge>}
        {duplicateOf.map((d) => <Badge key={d.id} variant="warning" title={d.content}>Possible duplicate of {d.key}</Badge>)}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{long && !expanded ? note.content.slice(0, LONG) + "…" : note.content}</p>
      {long && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show all"}</button>}
      <p className="text-xs text-muted-foreground">Updated {when(note.updated_at)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onHistory}>History</Button>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`Select ${note.key} for merging`} checked={selected} onChange={onToggle} />Select</label>
        <Button variant="outline" size="sm" className="ml-auto text-status-critical" disabled={busy}
          onClick={() => { if (window.confirm(`Delete the note “${note.key}”? You can restore it from Recently deleted.`)) void mutate(() => api.ai.memory.remove(note.id)); }}>Delete</Button>
      </div>
    </div>
  );
}

function MergeDialog({ notes, agent, categories, busy, mutate, onClose }: {
  notes: PersonalMemory[]; agent: AIAgent; categories: string[]; busy: boolean; mutate: Mutate; onClose: () => void;
}) {
  const [key, setKey] = useState(notes[0].key);
  const [category, setCategory] = useState(notes.find((n) => n.category)?.category ?? "");
  const [scope, setScope] = useState<Scope>(notes.some((n) => n.agent_id) ? "nova" : "shared");
  const [kind, setKind] = useState<MemoryKind>(notes[0].kind ?? "fact");
  const [content, setContent] = useState(notes.map((n) => n.content).join("\n\n"));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Merge {notes.length} notes</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">The notes are replaced by one; each original stays in Recently deleted and can be restored.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Merged key" value={key} pattern="[a-zA-Z0-9_.-]+" maxLength={100} onChange={(e) => setKey(e.target.value)} />
          <Input aria-label="Merged category" list="memory-categories" value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} />
          <ScopeSelect label="Merged scope" value={scope} onChange={setScope} />
          <KindSelect label="Merged kind" value={kind} onChange={setKind} />
        </div>
        <datalist id="memory-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        <textarea aria-label="Merged content" className="min-h-48 w-full rounded-md border border-input bg-secondary p-2 text-sm" maxLength={8000} value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !key.trim() || !content.trim()} onClick={() => void mutate(() => api.ai.memory.merge({
            ids: notes.map((n) => n.id), key: key.trim(), content: content.trim(), category: category.trim() || null, kind,
            agent_id: scope === "nova" ? agent.id : null })).then((ok) => { if (ok) onClose(); })}>Merge notes</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ title, load, busy, mutate, onClose }: {
  title: string; load: () => Promise<{ items: MemoryVersion[] }>; busy: boolean; mutate: Mutate; onClose: () => void;
}) {
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setVersions(r.items); }).catch((err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [load]);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {versions === null && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : versions &&
          <VersionList versions={versions} busy={busy} onRestore={(v) => void mutate(() => api.ai.memory.restore(v.id)).then((ok) => { if (ok) onClose(); })} />}
      </DialogContent>
    </Dialog>
  );
}

export function MemoryOverview({ agent, notes, busy, mutate }: { agent: AIAgent; notes: PersonalMemory[]; busy: boolean; mutate: Mutate }) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | Scope>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [merging, setMerging] = useState(false);
  const [history, setHistory] = useState<{ title: string; load: () => Promise<{ items: MemoryVersion[] }> } | null>(null);
  const [pairs, setPairs] = useState<{ a: string; b: string }[]>([]);

  const mine = useMemo(() => notes.filter((n) => (n.agent_id === null || n.agent_id === agent.id) && !n.key.startsWith(IMPORTED_PREFIX)), [notes, agent.id]);
  const imported = notes.filter((n) => n.agent_id === null && n.key.startsWith(IMPORTED_PREFIX)).length;
  const categories = useMemo(() => [...new Set(mine.map((n) => n.category).filter((c): c is string => !!c))].sort(), [mine]);
  useEffect(() => {
    let live = true;
    api.ai.memory.duplicates().then((r) => { if (live) setPairs(Array.isArray(r?.pairs) ? r.pairs : []); }).catch(() => { if (live) setPairs([]); });
    return () => { live = false; };
  }, [notes]);
  const byId = useMemo(() => new Map(mine.map((n) => [n.id, n])), [mine]);
  const duplicates = (id: string) => pairs.flatMap((p) => (p.a === id ? [p.b] : p.b === id ? [p.a] : [])).map((other) => byId.get(other)).filter((n): n is PersonalMemory => !!n);

  const needle = search.trim().toLowerCase();
  const visible = mine.filter((n) => (scope === "all" || (scope === "nova") === (n.agent_id === agent.id))
    && (!needle || n.key.toLowerCase().includes(needle) || n.content.toLowerCase().includes(needle) || (n.category ?? "").toLowerCase().includes(needle)));
  const groups = new Map<string, PersonalMemory[]>();
  for (const note of visible) groups.set(groupName(note), [...(groups.get(groupName(note)) ?? []), note]);
  const order = [...groups.keys()].sort((a, b) => (a === UNCATEGORIZED || a === "Journal" ? 1 : 0) - (b === UNCATEGORIZED || b === "Journal" ? 1 : 0) || a.localeCompare(b));
  const toggle = (set: Set<string>, value: string) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };
  const chosen = [...selected].map((id) => byId.get(id)).filter((n): n is PersonalMemory => !!n);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input aria-label="Search memories" placeholder="Search keys, categories and content…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Filter by scope" className={fieldClass} value={scope} onChange={(e) => setScope(e.target.value as "all" | Scope)}>
          <option value="all">All scopes</option>
          <option value="nova">Nova only</option>
          <option value="shared">Shared</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => setAdding(true)}>Add memory</Button>
        <Button size="sm" variant="outline" disabled={busy || chosen.length < 2} onClick={() => setMerging(true)}>Merge selected ({chosen.length})</Button>
        <Button size="sm" variant="outline" onClick={() => setHistory({ title: "Recently deleted and merged notes", load: () => api.ai.memory.history({ deleted: true }) })}>Recently deleted</Button>
        {collapsed.size > 0
          ? <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>Expand all</Button>
          : <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(order))}>Collapse all</Button>}
      </div>
      <p className="text-xs text-muted-foreground">
        {mine.length} notes in {categories.length} categories.{imported > 0 && ` ${imported} imported homelab notes (claude.*) are searchable by agents but not listed here.`}
        {" "}Never store passwords or keys.
      </p>
      {adding && <NoteEditor note={null} agent={agent} categories={categories} busy={busy} mutate={mutate} onDone={() => setAdding(false)} />}
      {order.map((group) => {
        const open = !collapsed.has(group);
        const items = groups.get(group) ?? [];
        return (
          <section key={group} className="rounded-md border border-border" data-category={group}>
            <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium" onClick={() => setCollapsed(toggle(collapsed, group))}>
              {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{group}</span>
              <Badge variant="outline" className="ml-auto">{items.length}</Badge>
            </button>
            {open && (
              <div className="space-y-2 px-3 pb-3">
                {items.map((note) => <NoteCard key={note.id} note={note} agent={agent} categories={categories} busy={busy} mutate={mutate}
                  duplicateOf={duplicates(note.id)} selected={selected.has(note.id)} onToggle={() => setSelected(toggle(selected, note.id))}
                  onHistory={() => setHistory({ title: `History of ${note.key}`, load: () => api.ai.memory.history({ memoryId: note.id }) })} />)}
              </div>
            )}
          </section>
        );
      })}
      {!visible.length && <p className="text-sm text-muted-foreground">{mine.length ? "No memories match." : "Nova has no notes about you yet. Add one, or use Import & Organize."}</p>}
      {merging && chosen.length >= 2 && <MergeDialog notes={chosen} agent={agent} categories={categories} busy={busy} mutate={mutate}
        onClose={() => { setMerging(false); setSelected(new Set()); }} />}
      {history && <HistoryDialog title={history.title} load={history.load} busy={busy} mutate={mutate} onClose={() => setHistory(null)} />}
    </div>
  );
}
