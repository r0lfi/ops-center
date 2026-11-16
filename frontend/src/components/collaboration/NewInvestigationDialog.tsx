import { useEffect, useState } from "react";
import type { AIAgent, CollaborationSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const input = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-400";
export function NewInvestigationDialog({ open, onOpenChange, agents, settings, busy, onStart, error }: {
  open: boolean; onOpenChange: (open: boolean) => void; agents: AIAgent[]; settings: CollaborationSettings | null; busy: boolean; onStart: (message: string, lead: string) => Promise<boolean>; error: string;
}) {
  const [problem, setProblem] = useState(""), [resources, setResources] = useState(""), [context, setContext] = useState(""), [severity, setSeverity] = useState(""), [lead, setLead] = useState("coordinator");
  const permitted = agents.filter(agent => agent.enabled && settings?.policy.agents[agent.slug]?.read);
  useEffect(() => { if (!permitted.some(agent => agent.slug === lead)) setLead(permitted[0]?.slug || ""); }, [agents, settings, lead]);
  const hasContext = !!(resources.trim() || context.trim() || severity);
  const message = !hasContext ? problem.trim() : ["Problem: " + problem.trim(), resources.trim() ? "Affected resources: " + resources.trim() : "", severity ? "Severity (operator supplied): " + severity : "", context.trim() ? "Context:\n" + context.trim() : ""].filter(Boolean).join("\n\n");
  const valid = !!problem.trim() && message.length <= 4000 && permitted.some(agent => agent.slug === lead) && !!settings?.policy.enabled;
  async function submit() {
    if (!valid || busy) return;
    if (await onStart(message, lead)) { setProblem(""); setResources(""); setContext(""); setSeverity(""); onOpenChange(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent className="max-w-xl">
    <DialogHeader><DialogTitle>New investigation</DialogTitle><DialogDescription>Describe the problem. Your lead agent can bring in permitted specialists and share findings here.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="block space-y-1.5 text-sm"><span>Problem description</span><textarea autoFocus className={input} rows={3} required maxLength={4000} value={problem} disabled={busy} onChange={event => setProblem(event.target.value)} placeholder="What is happening, and what should happen?"/></label>
      <label className="block space-y-1.5 text-sm"><span>Affected hosts or resources <span className="text-xs text-muted-foreground">· optional</span></span><input className={input} maxLength={300} value={resources} disabled={busy} onChange={event => setResources(event.target.value)} placeholder="Host, service or application"/></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm"><span>Lead agent</span><select className={input} required value={lead} disabled={busy} onChange={event => setLead(event.target.value)}>{!permitted.length && <option value="">No permitted agents</option>}{permitted.map(agent => <option key={agent.slug} value={agent.slug}>{agent.name}</option>)}</select></label>
        <label className="block space-y-1.5 text-sm"><span>Severity <span className="text-xs text-muted-foreground">· optional</span></span><select className={input} value={severity} disabled={busy} onChange={event => setSeverity(event.target.value)}><option value="">Not specified</option>{["Low","Medium","High","Critical"].map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <label className="block space-y-1.5 text-sm"><span>Additional context <span className="text-xs text-muted-foreground">· optional</span></span><textarea className={input} rows={2} maxLength={600} value={context} disabled={busy} onChange={event => setContext(event.target.value)} placeholder="Recent changes, checks already completed, or relevant evidence"/></label>
      <p className={"text-xs " + (message.length > 4000 ? "text-red-400" : "text-muted-foreground")} aria-live="polite">{message.length} / 4000 total characters{message.length > 4000 ? " · Shorten the description or optional context to start." : ""}</p>
      {!settings?.policy.enabled && <p className="text-xs text-amber-300">An administrator must enable collaboration and agent permissions in Settings.</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-4"><span className="text-xs text-muted-foreground">Uses the shared weekly AI budget.</span><div className="flex gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || !valid}>{busy ? "Starting…" : "Start investigation"}</Button></div></div>
    </form>
  </DialogContent></Dialog>;
}
