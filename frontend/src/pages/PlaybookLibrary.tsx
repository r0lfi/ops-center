import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, BookOpen, FileCode2, RefreshCw, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { playbookMetadata } from "@/lib/playbookCatalog";
import { useAuth } from "@/lib/auth";

export default function PlaybookLibrary() {
  const { hasRole } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("playbook") || "";
  const urlQuery = params.get("q") || "";
  const [search, setSearch] = useState(urlQuery);
  const category = params.get("category") || "";
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState("");

  function update(key: string, value: string, replace = false) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace });
  }
  useEffect(() => { setSearch(urlQuery); }, [urlQuery]);
  useEffect(() => {
    if (search === urlQuery) return;
    const timer = setTimeout(() => {
      setParams(previous => {
        const next = new URLSearchParams(previous);
        if (search) next.set("q", search); else next.delete("q");
        return next;
      }, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [search, urlQuery, setParams]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.ansible.list().then(value => { if (live) { setNames([...new Set(value)].sort()); setError(""); } })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : "Could not load playbooks"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    setSource(null); setSourceError("");
    if (!selected || !names?.includes(selected)) return;
    api.ansible.get(selected).then(value => { if (live) setSource(value.content); })
      .catch(err => { if (live) setSourceError(err instanceof Error ? err.message : "Could not load source"); });
    return () => { live = false; };
  }, [selected, names, refresh]);

  useEffect(() => {
    if (selected && names) document.getElementById("library-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected, names]);

  const entries = useMemo(() => (names ?? []).map(name => ({ name, ...playbookMetadata(name) })), [names]);
  const categories = useMemo(() => [...new Set(entries.map(p => p.category))].sort(), [entries]);
  const filtered = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter(p => (!category || p.category === category) && words.every(word => `${p.name} ${p.title} ${p.category} ${p.description}`.toLowerCase().includes(word)));
  }, [entries, category, search]);
  const detail = entries.find(p => p.name === selected);

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><Link to="/automation" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><ArrowLeft className="h-3 w-3"/>Automation</Link><h1 className="flex items-center gap-2 text-2xl font-semibold"><BookOpen className="h-6 w-6 text-primary"/>Playbook Library</h1><p className="mt-1 text-sm text-muted-foreground">Browse registered Ansible playbooks by purpose, search the catalog and inspect their source.</p></div><Button variant="outline" disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshCw className="mr-2 h-4 w-4"/>{loading ? "Loading…" : "Refresh"}</Button></div>
    <Card><CardContent className="space-y-4 pt-4">
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">Search playbooks<div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4"/><Input className="pl-9" aria-label="Search playbooks" placeholder="Name, description or category…" value={search} onChange={e => setSearch(e.target.value)}/></div></label><label className="min-w-48 space-y-1 text-xs text-muted-foreground">Category<Select aria-label="Playbook category" value={category} onChange={e => update("category", e.target.value)}><option value="">All categories</option>{category && !categories.includes(category) && <option>{category}</option>}{categories.map(c => <option key={c}>{c}</option>)}</Select></label></div>
      {error && <p role="alert" className="text-sm text-destructive">Could not refresh the library: {error}{names ? ". Showing the previous list." : ""}</p>}
      {names === null && !error && <p className="py-6 text-center text-muted-foreground">Loading playbook library…</p>}
      {names && <>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{filtered.length} of {names.length} playbooks · {categories.length} categories</span>{(search || category) && <Button size="sm" variant="ghost" onClick={() => { setSearch(""); const next = new URLSearchParams(params); next.delete("q"); next.delete("category"); setParams(next); }}>Clear filters</Button>}</div>
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{filtered.map(p => <button key={p.name} aria-pressed={selected === p.name} onClick={() => update("playbook", p.name)} className={`flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent/50 ${selected === p.name ? "border-primary bg-accent" : "border-border"}`}><Badge variant="secondary">{p.category}</Badge><span className="flex items-center gap-2 font-medium"><FileCode2 className="h-4 w-4 shrink-0 text-primary"/>{p.title}</span><code className="break-all text-xs text-primary">{p.name}</code><span className="text-sm text-muted-foreground">{p.description}</span><span className="mt-auto pt-2 text-xs text-primary">View source and details →</span></button>)}</div>
        {!filtered.length && <p className="py-8 text-center text-muted-foreground">{names.length ? "No playbooks match your search. Try a different term or category." : "No playbooks are registered yet."}</p>}
      </>}
    </CardContent></Card>
    {selected && names && <Card id="library-details" className="scroll-mt-4"><CardContent className="space-y-3 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{detail?.title || selected}</h2><Button size="sm" variant="outline" onClick={() => update("playbook", "")}>Close details</Button></div>
      {!detail ? <p role="alert" className="text-sm text-destructive">This playbook is not in the current library.</p> : <>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{detail.category}</Badge><code className="break-all text-xs text-primary">{detail.name}</code></div>
        <p className="text-sm text-muted-foreground">{detail.description}</p>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Playbook source · YAML</h3><Button asChild size="sm" variant="outline"><Link to={`/automation?source=${encodeURIComponent(detail.name)}#playbook-source`}>{hasRole("admin") ? "Open in editor" : "Open source view"}</Link></Button></div>
        {sourceError && <p role="alert" className="text-sm text-destructive">{sourceError}</p>}
        {source === null && !sourceError ? <p className="text-sm text-muted-foreground">Loading source…</p> : source !== null && <pre tabIndex={0} aria-label="Playbook YAML source" className="max-h-[36rem] overflow-auto rounded-md border border-border bg-background p-4 text-xs leading-relaxed"><code>{source}</code></pre>}
      </>}
    </CardContent></Card>}
  </div>;
}
