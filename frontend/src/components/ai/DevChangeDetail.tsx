import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCopy, Download, FileCode2, FileText, FlaskConical, Settings2 } from "lucide-react";
import { Link } from "react-router-dom";

import { useReauth } from "@/components/ReauthDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, needsReauth, type DevChangeDetail } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_ICON = { code: FileCode2, test: FlaskConical, docs: FileText, config: Settings2 };
const CHECK_STYLE = {
  passed: ["ok", "Passed"], failed: ["critical", "Failed"], warning: ["warning", "Check"], not_run: ["unknown", "Not run"],
} as const;
const DECISION = {
  approve: "Approved for production", request_changes: "Changes requested", reject: "Rejected",
  released: "Release recorded", release_failed: "Release failed", rolled_back: "Rolled back",
} as Record<string, string>;

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-2", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** One file of a unified diff, folded by default. */
function DiffView({ patch }: { patch: string }) {
  const files = patch.split(/(?=^diff --git )/m).filter(Boolean);
  return (
    <div className="space-y-2">
      {files.map((file, i) => {
        const name = /^diff --git a\/\S+ b\/(\S+)/.exec(file)?.[1] ?? `part ${i + 1}`;
        return (
          <details key={name + i} className="overflow-hidden rounded-md border border-border" open={files.length === 1}>
            <summary className="cursor-pointer bg-secondary/40 px-3 py-1.5 font-mono text-xs">{name}</summary>
            <pre className="ops-scrollbar max-h-96 overflow-auto text-[11px] leading-5">
              {file.split("\n").map((line, n) => (
                <div key={n} className={cn("px-3",
                  line.startsWith("+") && !line.startsWith("+++") && "bg-status-ok/10 text-status-ok",
                  line.startsWith("-") && !line.startsWith("---") && "bg-status-critical/10 text-status-critical",
                  line.startsWith("@@") && "text-primary")}>{line || " "}</div>
              ))}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

/** Expanded view of one developer change: what was built, checks, timeline and the human decision. */
export function DevChangeDetailPanel({ id, canDecide, onChanged }: { id: string; canDecide: boolean; onChanged: () => void }) {
  const withReauth = useReauth();
  const [detail, setDetail] = useState<DevChangeDetail | null>(null);
  const [error, setError] = useState("");
  const [patch, setPatch] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [comment, setComment] = useState("");
  const [releaseRef, setReleaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => api.ai.developer.change(id).then(d => { setDetail(d); setError(""); })
    .catch(e => setError(e instanceof Error ? e.message : "Failed to load")), [id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function openDiff() {
    setShowDiff(v => !v);
    if (patch === null && detail?.has_patch && canDecide) {
      try { setPatch(await api.ai.proposals.patch(id)); } catch (e) { setError(e instanceof Error ? e.message : "Failed to load the patch"); }
    }
  }

  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(true); setError(""); setDone("");
    try {
      await withReauth(run);
      setDone(label); setComment(""); await load(); onChanged();
    } catch (e) {
      if (!needsReauth(e) && !(e instanceof Error && e.message === "Confirmation cancelled")) setError(e instanceof Error ? e.message : "Request failed");
    } finally { setBusy(false); }
  }

  async function download() {
    const text = patch ?? await api.ai.proposals.patch(id);
    const url = URL.createObjectURL(new Blob([text], { type: "text/x-diff" }));
    Object.assign(document.createElement("a"), { href: url, download: `tool-proposal-${id.slice(0, 8)}.patch` }).click();
    URL.revokeObjectURL(url);
  }

  if (!detail) return <div className="p-4 text-sm text-muted-foreground">{error || "Loading…"}</div>;
  const failedCheck = detail.checks.some(c => c.result === "failed");
  const command = detail.patch_sha256 ? `scripts/admin/apply-tool-proposal.sh ${detail.id} tool-proposal-${detail.id.slice(0, 8)}.patch ${detail.patch_sha256}` : "";
  const traceId = detail.developer_run?.id.replace(/-/g, "");

  return (
    <div className="grid gap-5 border-t border-border/60 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <Section title="What was asked for">
          <dl className="grid gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[8rem_1fr]">
            {(["missing", "design", "security", "tests"] as const).filter(k => detail.details[k]).map(k => (
              <div key={k} className="contents">
                <dt className="text-xs text-muted-foreground">{{ missing: "Needed", design: "Approach", security: "Security", tests: "Tests" }[k]}</dt>
                <dd className="line-clamp-4 whitespace-pre-wrap break-words">{detail.details[k]}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title={`Changed files (${detail.files_changed.length})`}>
          {detail.files_changed.length === 0 && <p className="text-sm text-muted-foreground">{detail.stage === "working" ? "Nothing submitted yet." : "No patch."}</p>}
          <ul className="divide-y divide-border/50 rounded-md border border-border/60 text-sm">
            {detail.files_changed.map(f => {
              const Icon = KIND_ICON[f.kind];
              return (
                <li key={f.path} className="flex items-center gap-2 px-3 py-1.5">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>{f.path}</span>
                  {f.status !== "modified" && <Badge variant="secondary">{f.status}</Badge>}
                  <span className="shrink-0 font-mono text-xs"><span className="text-status-ok">+{f.added}</span> <span className="text-status-critical">−{f.removed}</span></span>
                </li>
              );
            })}
          </ul>
          {detail.has_patch && canDecide && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={openDiff}>{showDiff ? "Hide changes" : "Show changes"}</Button>
              <Button size="sm" variant="outline" onClick={() => void download()}><Download className="h-3.5 w-3.5" />Download patch</Button>
            </div>
          )}
          {showDiff && (patch === null ? <p className="text-sm text-muted-foreground">Loading changes…</p> : <DiffView patch={patch} />)}
        </Section>

        {detail.notes && (
          <Section title="Developer notes">
            <p className="ops-scrollbar max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-3 text-xs">{detail.notes}</p>
          </Section>
        )}
      </div>

      <div className="min-w-0 space-y-5">
        <Section title="Checks">
          {detail.checks.length === 0 && <p className="text-sm text-muted-foreground">Checks run once the patch is finished.</p>}
          <ul className="space-y-1.5">
            {detail.checks.map(c => {
              const [variant, label] = CHECK_STYLE[c.result];
              return (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  <Badge variant={variant} className="mt-0.5 shrink-0">{label}</Badge>
                  <span className="min-w-0"><span className="font-medium">{c.name}</span><span className="block text-xs text-muted-foreground">{c.detail}</span></span>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Timeline">
          <ol className="relative space-y-2 border-l border-border pl-4">
            {detail.timeline.map((e, i) => (
              <li key={i} className="text-sm">
                <span className="absolute -left-[4.5px] mt-1.5 h-2 w-2 rounded-full bg-primary/70" aria-hidden="true" />
                <span>{e.text}</span>
                <span className="block text-xs text-muted-foreground">{formatDateTime(e.at)}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-3 text-xs">
            {detail.developer_run && <Link className="text-primary hover:underline" to={`/ai-agents/tasks?task=${detail.developer_run.id}`}>Developer run and logs →</Link>}
            {traceId && <Link className="text-primary hover:underline" to={`/ai-traffic/trace?trace=${traceId}`}>Network trace ({detail.traffic_events} events) →</Link>}
            {detail.task_id && <Link className="text-primary hover:underline" to={`/ai-agents/tasks?task=${detail.task_id}`}>Originating task →</Link>}
          </div>
        </Section>

        {canDecide && (
          <Section title="Decision" className="rounded-lg border border-border bg-background/40 p-3">
            {error && <p role="alert" className="text-sm text-status-critical">{error}</p>}
            {done && <p role="status" className="flex items-center gap-1 text-sm text-status-ok"><Check className="h-4 w-4" />{done}</p>}

            {detail.stage === "ready_for_review" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Approval covers exactly this patch ({detail.patch_sha256?.slice(0, 12)}…) and needs your password. It deploys nothing.</p>
                <textarea aria-label="Review comment" value={comment} onChange={e => setComment(e.target.value)} rows={3} maxLength={2000}
                  placeholder="Comment (required when requesting changes)"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || failedCheck} title={failedCheck ? "A required check failed" : undefined}
                    onClick={() => act("Approved for production", () => api.ai.proposals.review(id, "approve", comment, detail.patch_sha256))}>Approve</Button>
                  <Button size="sm" variant="outline" disabled={busy || !comment.trim()}
                    onClick={() => act("Changes requested", () => api.ai.proposals.review(id, "request_changes", comment))}>Request changes</Button>
                  <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => act("Rejected", () => api.ai.proposals.review(id, "reject", comment))}>Reject</Button>
                </div>
              </div>
            )}

            {detail.stage === "approved" && (
              <div className="space-y-2 text-sm">
                <p>Approved by <strong>{detail.approved_by}</strong>{detail.approved_at ? ` · ${formatDateTime(detail.approved_at)}` : ""}. Apply it on its own branch, test it and release it as usual:</p>
                <div className="flex items-start gap-2 rounded-md bg-secondary/50 p-2">
                  <code className="min-w-0 flex-1 break-all text-[11px]">{command}</code>
                  <button type="button" aria-label="Copy command" className="rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => { void navigator.clipboard?.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
                    {copied ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
                  </button>
                </div>
                <Input aria-label="Release commit or tag" placeholder="Commit, tag or release (e.g. 4f2c1ab)" value={releaseRef} maxLength={200} onChange={e => setReleaseRef(e.target.value)} />
                <textarea aria-label="Release note" value={comment} onChange={e => setComment(e.target.value)} rows={2} maxLength={500} placeholder="Note"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || !releaseRef.trim()} onClick={() => act("Release recorded", () => api.ai.proposals.deployed(id, comment, releaseRef))}>Record release</Button>
                  <Button size="sm" variant="outline" disabled={busy || !comment.trim()} onClick={() => act("Failed release recorded", () => api.ai.proposals.releaseOutcome(id, "release_failed", comment, releaseRef))}>Record failed release</Button>
                  <Button size="sm" variant="ghost" disabled={busy || !comment.trim()} onClick={() => act("Changes requested", () => api.ai.proposals.review(id, "request_changes", comment))}>Request changes</Button>
                </div>
              </div>
            )}

            {detail.stage === "in_production" && (
              <div className="space-y-2 text-sm">
                <p>Released{detail.release_ref ? <> in <code>{detail.release_ref}</code></> : ""}. If it was rolled back, record why:</p>
                <textarea aria-label="Rollback note" value={comment} onChange={e => setComment(e.target.value)} rows={2} maxLength={1000} placeholder="What happened"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                <Button size="sm" variant="outline" disabled={busy || !comment.trim()} onClick={() => act("Rollback recorded", () => api.ai.proposals.releaseOutcome(id, "rolled_back", comment, releaseRef))}>Record rollback</Button>
              </div>
            )}

            {(detail.stage === "proposed" || detail.stage === "changes_requested") && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => act("Developer Agent started", () => api.ai.proposals.approve(id))}>
                  {detail.stage === "changes_requested" ? "Restart development with the requested changes" : "Approve for development"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("Rejected", () => api.ai.proposals.review(id, "reject", comment))}>Reject</Button>
              </div>
            )}
            {["working", "rejected", "failed", "rolled_back"].includes(detail.stage) && !done && (
              <p className="text-sm text-muted-foreground">{detail.stage === "working" ? "Waiting for the Developer Agent to finish." : "No decision pending."}</p>
            )}
          </Section>
        )}

        {detail.reviews.length > 0 && (
          <Section title="Decisions (audit)">
            <ul className="space-y-1.5 text-sm">
              {detail.reviews.map((r, i) => (
                <li key={i}>
                  <span className="font-medium">{DECISION[r.decision] ?? r.decision}</span> · {r.decided_by} · <span className="text-xs text-muted-foreground">{formatDateTime(r.decided_at)}</span>
                  {r.release_ref && <span className="ml-1 font-mono text-xs">{r.release_ref}</span>}
                  {r.comment && <span className="block whitespace-pre-wrap break-words text-xs text-muted-foreground">{r.comment}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}
