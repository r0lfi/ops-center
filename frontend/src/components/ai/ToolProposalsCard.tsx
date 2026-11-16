import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { StatusBadge } from "@/components/ai/InvestigationBoard";
import { useReauth } from "@/components/ReauthDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AIToolProposal } from "@/lib/api";

const FIELDS: [string, string][] = [
  ["missing", "What is missing"], ["reason", "Why it is needed"], ["design", "How it would work"],
  ["reuse", "Reuses"], ["security", "Security"], ["permissions", "Permissions"], ["tests", "Tests"],
];

const OPEN_STATUSES: AIToolProposal["status"][] = ["proposed", "ready_for_review", "changes_requested"];

/** Long text stays a few lines high until the reader asks for the rest. */
function Expandable({ children, label, className = "", fade = "from-card" }: { children: ReactNode; label: string; className?: string; fade?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 4);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [children]);
  return (
    <div className={className}>
      <div ref={ref} className={`relative ${open ? "" : "max-h-24 overflow-hidden"}`}>
        {children}
        {!open && overflows && <div aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t ${fade} to-transparent`} />}
      </div>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="mt-1 text-xs text-primary hover:underline">
          {open ? "Show less" : `Show full ${label}`}
        </button>
      )}
    </div>
  );
}

/** The notes collect one line per developer run; show the newest entry and fold the history. */
function DevNotes({ notes }: { notes: string }) {
  const lines = notes.split("\n").filter(l => l.trim());
  const latest = lines[lines.length - 1] ?? "";
  const earlier = lines.slice(0, -1);
  return (
    <div className="mt-2 space-y-1 rounded-md bg-secondary p-2 text-xs">
      <Expandable label="note" fade="from-secondary"><p className="whitespace-pre-wrap break-words">{latest}</p></Expandable>
      {earlier.length > 0 && (
        <details>
          <summary className="cursor-pointer text-primary hover:underline">Earlier developer notes ({earlier.length})</summary>
          <ul className="mt-1 max-h-72 space-y-1 overflow-y-auto pr-1">
            {earlier.slice().reverse().map((line, i) => <li key={i} className="whitespace-pre-wrap break-words border-t border-border/50 pt-1 text-muted-foreground">{line}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Missing capabilities agents proposed. Approval allows development only; deployment is a separate release. */
export function ToolProposalsCard({ isAdmin, openOnly = false }: { isAdmin: boolean; openOnly?: boolean }) {
  const [proposals, setProposals] = useState<AIToolProposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});
  const withReauth = useReauth();

  const refresh = () => api.ai.proposals.list().then(setProposals).catch(() => {});
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id); setError("");
    try { await run(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(null); }
  }

  // Approval binds to the patch the server holds right now, and only when no required check failed.
  async function approveChange(p: AIToolProposal) {
    await act(p.id, async () => {
      const detail = await api.ai.developer.change(p.id);
      if (detail.checks.some(c => c.result === "failed")) throw new Error("A required check failed. Open the change to see why.");
      await withReauth(() => api.ai.proposals.review(p.id, "approve", comments[p.id] ?? "", detail.patch_sha256));
    });
  }

  async function download(p: AIToolProposal) {
    await act(p.id, async () => {
      const text = await api.ai.proposals.patch(p.id);
      const url = URL.createObjectURL(new Blob([text], { type: "text/x-diff" }));
      const link = Object.assign(document.createElement("a"), { href: url, download: `tool-proposal-${p.id.slice(0, 8)}.patch` });
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  // On the AI overview only proposals that still need a decision are shown, and the card hides when there are none.
  const shown = openOnly ? proposals.filter((p) => OPEN_STATUSES.includes(p.status)) : proposals;
  if (openOnly && shown.length === 0) return null;

  return (
    <Card id="proposals">
      <CardHeader className={openOnly ? "flex-row items-center justify-between space-y-0" : undefined}>
        <CardTitle className="text-base">{openOnly ? `Tool proposals waiting (${shown.length})` : "Tool proposals"}</CardTitle>
        {openOnly && <Link to="/ai-agents/approvals#proposals" className="text-xs text-primary hover:underline">All proposals →</Link>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className={openOnly ? "hidden" : "text-muted-foreground"}>
          Capabilities agents could not find among their tools. <strong className="text-foreground">Approve for development</strong> starts
          the Developer agent, which only writes a patch. Approve or request changes to the patch right here; the full review and the release record are under{" "}
          <Link to="/ai-agents/developer" className="text-primary hover:underline">Developer Agent</Link>.
          Approval never deploys code or grants an agent new access.
        </p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {shown.length === 0 && <p className="text-muted-foreground">No proposals.</p>}
        {shown.map((p) => (
          <details key={p.id} className="rounded-md border border-border p-3" open={p.status === "proposed" || p.status === "ready_for_review"}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <StatusBadge status={p.status === "proposed" ? "waiting_for_approval" : p.status} />
              <span className="font-medium">{p.title}</span>
              {p.task_id && <Link className="text-xs text-primary hover:underline" to={`/ai-agents/tasks?task=${encodeURIComponent(p.task_id)}`}>from task</Link>}
            </summary>
            <Expandable label="proposal" className="mt-2">
              <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                {FIELDS.filter(([key]) => p.details[key]).map(([key, label]) => (
                  <div key={key} className="contents">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words">{p.details[key]}</dd>
                  </div>
                ))}
              </dl>
            </Expandable>
            {p.patch_notes && <DevNotes notes={p.patch_notes} />}
            {p.decided_by && <p className="mt-2 text-xs text-muted-foreground">Decided by {p.decided_by}</p>}
            {isAdmin && p.status === "ready_for_review" && (
              <div className="mt-3 space-y-2" aria-label="Review decision">
                <textarea aria-label="Review comment" value={comments[p.id] ?? ""} rows={2} maxLength={2000}
                  onChange={e => setComments(c => ({ ...c, [p.id]: e.target.value }))}
                  placeholder="Comment (required when requesting changes)"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy === p.id} onClick={() => approveChange(p)}>Approve change</Button>
                  <Button size="sm" variant="outline" disabled={busy === p.id || !(comments[p.id] ?? "").trim()}
                    onClick={() => act(p.id, () => withReauth(() => api.ai.proposals.review(p.id, "request_changes", comments[p.id] ?? "")))}>Request changes</Button>
                </div>
                <p className="text-xs text-muted-foreground">Approval covers exactly the current patch, needs your password and deploys nothing.</p>
              </div>
            )}
            {isAdmin && (
              <div className="mt-3 flex flex-wrap gap-2">
                {(p.status === "proposed" || p.status === "changes_requested") && (
                  <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, () => api.ai.proposals.approve(p.id))}>Approve for development</Button>
                )}
                {p.has_patch && <Button size="sm" variant="outline" asChild><Link to={`/ai-agents/developer?change=${p.id}`}>Open change</Link></Button>}
                {p.has_patch && <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => download(p)}>Download patch</Button>}
                {p.status === "proposed" && !p.has_patch && (
                  <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => act(p.id, () => withReauth(() => api.ai.proposals.deployed(p.id)))}>Mark released (implemented by hand)</Button>
                )}
                {!["deployed", "rejected", "rolled_back"].includes(p.status) && (
                  <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => act(p.id, () => api.ai.proposals.reject(p.id))}>Reject</Button>
                )}
              </div>
            )}
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
