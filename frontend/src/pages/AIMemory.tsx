import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AIAgent, type AIHistory, type PersonalMemory } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function AIMemory() {
  const [notes, setNotes] = useState<PersonalMemory[]>([]);
  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [agentError, setAgentError] = useState("");
  const [scope, setScope] = useState("");
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [history, setHistory] = useState<AIHistory | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    api.ai.agents.list().then(data => { if (live) setAgents(data); }).catch(err => { if (live) setAgentError(String(err)); });
    return () => { live = false; };
  }, []);
  const visibleNotes = notes.filter(note => (note.agent_id || "") === scope);
  const scopeName = scope ? agents.find(agent => agent.id === scope)?.name || "Selected agent" : "Shared — all my agents";
  function selectScope(value: string) {
    setScope(value); setKey(""); setContent(""); setEditing(false);
  }
  useEffect(() => {
    let live = true;
    api.ai.memory.list().then(data => { if (live) { setNotes(data.items); setEnabled(data.enabled); setError(""); } }).catch(err => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [refresh]);
  useEffect(() => {
    let live = true; setHistory(null); setHistoryError("");
    const timer = setTimeout(() => api.ai.history({ q: search, offset }).then(data => { if (live) setHistory(data); }).catch(err => { if (live) setHistoryError(String(err)); }), 250);
    return () => { live = false; clearTimeout(timer); };
  }, [search, offset, refresh]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); setRefresh(v => v + 1); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">History &amp; memory</h1><p className="mt-1 text-sm text-muted-foreground">Your local conversation archive, shared notes and notes for individual web agents.</p></div><Button asChild variant="outline"><Link to="/ai-agents/chat">Open chat</Link></Button></div>
    <Card><CardContent className="space-y-3 pt-4">
      <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={enabled === true} disabled={enabled === null || busy} onChange={e => void mutate(() => api.ai.memory.preference(e.target.checked))}/>Use long-term memory for all my agents</label>
      <p className="text-sm text-muted-foreground">When enabled, agents can use your notes and retrieve relevant earlier discussions. With an external model, selected context is sent to that provider. Turning this off keeps the archive and limits automatic history to the current thread.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <h2 className="font-semibold">Personal notes</h2>
      <p className="text-sm text-muted-foreground">Each agent uses shared notes plus its own specialist notes. These belong to your user account. Specialist notes can describe domain knowledge, routines and responsibilities; they do not grant additional tools or permissions.</p>
      <label className="block space-y-1 text-sm"><span>Notes for</span><select aria-label="Memory scope" value={scope} onChange={e => selectScope(e.target.value)} disabled={busy} className="block w-full rounded-md border border-input bg-secondary px-3 py-2">
        <option value="">Shared — all my agents ({notes.filter(note => !note.agent_id).length})</option>
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({notes.filter(note => note.agent_id === agent.id).length})</option>)}
      </select></label>
      {agentError && <p role="alert" className="text-sm text-destructive">Could not load agents: {agentError}</p>}
      <p className="text-sm font-medium">{scopeName}</p>
      {scope && <p className="text-xs text-muted-foreground">These notes are loaded for this agent. Shared notes are also included automatically. Other agents may still see relevant conversation history or answers from delegated work.</p>}
      <p className="text-xs text-muted-foreground">Tell an agent “remember this for all agents” or “remember this only for your agent”, or add a note in the selected scope here. Never put passwords or API keys in notes. Deleting a note does not delete its original conversation or audit records.</p>
      <form className="space-y-2 rounded-md border border-border p-3" onSubmit={e => { e.preventDefault(); void mutate(async () => { await api.ai.memory.save(key, content, scope || null); setKey(""); setContent(""); setEditing(false); }); }}>
        <Input disabled={editing || busy} aria-label="Memory key" placeholder="Key, e.g. preferred_language" pattern="[a-zA-Z0-9_.-]+" maxLength={100} required value={key} onChange={e => setKey(e.target.value)}/>
        <textarea disabled={busy} aria-label="Memory content" className="min-h-20 w-full rounded-md border border-input bg-secondary p-2 text-sm" placeholder="What should your agents remember?" maxLength={2000} required value={content} onChange={e => setContent(e.target.value)}/>
        <Button disabled={busy || !key || !content.trim()}>{busy ? "Saving…" : editing ? "Update note" : "Save note"}</Button>
        {editing && <Button type="button" variant="outline" disabled={busy} onClick={() => { setKey(""); setContent(""); setEditing(false); }}>Cancel edit</Button>}
      </form>
      {visibleNotes.map(note => <div key={note.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3"><div className="min-w-0 flex-1"><p className="font-mono text-xs text-primary">{note.key}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.content}</p><p className="mt-1 text-xs text-muted-foreground">Updated {new Date(note.updated_at).toLocaleString()}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setKey(note.key); setContent(note.content); setEditing(true); }}>Edit</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Delete the memory note “${note.key}” from ${scopeName}? Its original conversation stays in the archive.`)) void mutate(async () => { await api.ai.memory.remove(note.id); if (editing && key === note.key) { setKey(""); setContent(""); setEditing(false); } }); }}>Delete</Button></div></div>)}
      {enabled !== null && !visibleNotes.length && <p className="text-sm text-muted-foreground">No notes in this scope yet. Your conversation archive is available below.</p>}
    </CardContent></Card>
    <Card><CardContent className="space-y-3 pt-4"><h2 className="font-semibold">Conversation archive</h2><Input aria-label="Search conversation history" value={search} onChange={e => { setSearch(e.target.value); setOffset(0); }} placeholder="Search your messages and agent responses…"/>
      {historyError && <p role="alert" className="text-sm text-destructive">{historyError}</p>}
      {!history && !historyError && <p className="text-sm text-muted-foreground">Loading history…</p>}
      {history?.items.map(({ task, agent }) => <details key={task.id} className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm"><span className="mr-2 text-primary">{agent}</span>{task.input_message.slice(0, 150)}<span className="ml-2 text-xs text-muted-foreground">{new Date(task.created_at).toLocaleString()} · {task.status}</span></summary><div className="mt-3 space-y-3 text-sm"><p className="whitespace-pre-wrap break-words">{task.input_message}</p><p className="whitespace-pre-wrap break-words rounded bg-accent/50 p-3">{task.response_message || task.error_message || "Waiting for a response"}</p><Link className="text-primary hover:underline" to={`/ai-agents/chat?agent=${encodeURIComponent(agent)}${task.conversation_key ? `&conversation=${encodeURIComponent(task.conversation_key)}` : ""}`}>Continue with this agent</Link></div></details>)}
      {history && <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{history.total} exchanges{history.total === 0 ? " found" : ""}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</Button><Button size="sm" variant="outline" disabled={offset + 30 >= history.total} onClick={() => setOffset(offset + 30)}>Next</Button></div></div>}
    </CardContent></Card>
  </div>;
}
