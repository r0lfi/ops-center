import { useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { canRespondToAction } from "@/lib/aiApprovals";
import { api, type AIAction, type AIAgent, type AIProvider, type AITask, type Host } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDayTime, formatTime } from "@/lib/format";
import { MOTION_LABEL, type ActivityRow, type FloorAgent } from "@/lib/opsFloor/model";
import { severityVariant } from "@/lib/severity";
import { Badge } from "@/components/ui/badge";

import { roleIcon } from "@/components/ai/AgentIdentity";

import { AgentFigure } from "./AgentFigure";
import { StatusGlyph, StatusLabel } from "./StatusGlyph";

const RISK_WORD: Record<AIAction["risk"], string> = { low: "low", medium: "medium", high: "critical" };

function targetOf(action: AIAction, hosts: Host[]) {
  const named = hosts.find((host) => host.id === action.host_id)?.hostname;
  const args = action.arguments as Record<string, unknown>;
  const fromArgs = ["hostname", "host", "target", "container", "name"].map((key) => args[key]).find((value) => typeof value === "string") as string | undefined;
  return named ?? fromArgs ?? "No specific target";
}

function ApprovalBox({ action, hosts, onDone }: { action: AIAction; hosts: Host[]; onDone: () => void }) {
  const { hasRole } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = canRespondToAction(action, hasRole);

  async function respond(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await (decision === "approve" ? api.ai.actions.approve(action.id) : api.ai.actions.reject(action.id));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the decision");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="of-approval" role="group" aria-label={`Approval for ${action.action}`}>
      <p className="of-approval-title">Needs your approval</p>
      <p>{action.action}</p>
      {action.reason && <p className="of-muted">{action.reason}</p>}
      <dl>
        <dt>Target</dt><dd>{targetOf(action, hosts)}</dd>
        <dt>Tool</dt><dd className="of-mono">{action.tool}</dd>
        <dt>Risk</dt><dd><Badge variant={severityVariant(RISK_WORD[action.risk])}>L{action.approval_level} - {action.risk}</Badge></dd>
        {action.expires_at && <><dt>Expires</dt><dd>{formatTime(action.expires_at)}</dd></>}
      </dl>
      {error && <p role="alert" className="of-error">{error}</p>}
      {allowed
        ? <div className="of-actions"><Button disabled={busy} onClick={() => respond("approve")}>Approve</Button><Button variant="outline" disabled={busy} onClick={() => respond("reject")}>Reject</Button></div>
        : <p className="of-muted">Your role cannot answer this request.</p>}
    </div>
  );
}

export function DetailPanel({ agent, config, providers, hosts, onChanged, rows = [], history = [], name = (slug) => slug, onOpenTask, onSelect }: {
  agent: FloorAgent | null;
  config: AIAgent | null;
  providers: AIProvider[];
  hosts: Host[];
  onChanged: () => void;
  /** This agent's recent events, newest first. */
  rows?: ActivityRow[];
  /** This agent's recent tasks, newest first. */
  history?: AITask[];
  name?: (slug: string) => string;
  onOpenTask?: (taskId: string) => void;
  onSelect?: (slug: string) => void;
}) {
  const { hasRole } = useAuth();
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!agent) return <aside className="of-panel of-detail" aria-label="Agent details"><p className="of-empty">Select an agent to see its status and tools.</p></aside>;

  const selected = agent;
  const task: AITask | null = agent.currentTask;
  const canStop = hasRole("operator") && !!task && (task.status === "queued" || task.status === "running");
  const provider = providers.find((item) => item.id === config?.provider_id)?.display_name;
  const canMessage = agent.enabled && !agent.external;
  const Role = roleIcon(agent.slug);
  // Who it works with on this task: what the task recorded plus the agent it is talking to right now.
  const partners = [...new Set([...(task?.agents_used ?? []), ...(agent.peer ? [agent.peer] : [])])].filter((slug) => slug !== agent.slug);
  const toolsNow = [...new Set((task?.tools_used ?? []).map((step) => step.tool))];

  async function setEnabled(enabled: boolean) {
    if (!config) return;
    setSaving(true);
    setActionError(null);
    try { await api.ai.agents.update(config.id, { enabled }); onChanged(); }
    catch (err) { setActionError(err instanceof Error ? err.message : "Could not change this agent"); }
    finally { setSaving(false); }
  }

  async function stop() {
    if (!task) return;
    setStopping(true);
    setActionError(null);
    try { await api.ai.tasks.cancel(task.id); onChanged(); }
    catch (err) { setActionError(err instanceof Error ? err.message : "Could not stop this task"); }
    finally { setStopping(false); }
  }

  async function send() {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setReply("Working on it…");
    const keyName = `ops_chat_conversation:${selected.slug}`;
    try {
      const key = localStorage.getItem(keyName) ?? `web:${selected.slug}:${crypto.randomUUID()}`;
      localStorage.setItem(keyName, key);
      const created = await api.ai.ask(text, selected.slug, key);
      setMessage("");
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const updated = await api.ai.tasks.get(created.id);
        if (updated.status === "completed" || updated.status === "failed" || updated.status === "cancelled") {
          setReply(updated.response_message ?? updated.error_message ?? `Task ${updated.status}.`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      setReply("Still working. Open chat for the full conversation.");
    } catch {
      setReply("Could not reach this agent. Open chat for the full conversation.");
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="of-panel of-detail" aria-label="Agent details">
      <div className="of-detail-head">
        <span className="of-card-face"><AgentFigure slug={agent.slug} size={40} /></span>
        <div>
          <h2>{agent.name}</h2>
          <div className="of-detail-meta"><StatusLabel status={agent.status} />{agent.status === "working" && agent.motion !== "busy" && <span>{MOTION_LABEL[agent.motion]}</span>}<span><Role className="inline h-3.5 w-3.5" aria-hidden="true" /> {agent.roomName}</span></div>
        </div>
      </div>
      {agent.role && <p className="of-muted">{agent.role}</p>}

      {(agent.runningTasks > 1 || agent.queuedTasks > 0) && (() => {
        const open = history.filter((item) => item.status === "running" || item.status === "queued");
        const hidden = agent.runningTasks + agent.queuedTasks - open.length;
        return (
          <div>
            <h3>Running tasks ({agent.runningTasks}{agent.queuedTasks ? `, ${agent.queuedTasks} queued` : ""})</h3>
            <ul className="of-mini-log">{open.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onOpenTask?.(item.id)}>
                  <time>{formatDayTime(item.started_at ?? item.created_at)}</time>
                  <span className={`of-tx-${item.status === "queued" ? "idle" : "working"}`}>{item.status}</span>
                  <span>{item.tools_used.length} steps</span>
                </button>
              </li>
            ))}</ul>
            {hidden > 0 && <p className="of-muted">{hidden} more not listed here (older than the recent task list, or another person's private task).</p>}
          </div>
        );
      })()}

      <div>
        <h3>Current task</h3>
        <p>{task?.status === "cancelled" ? "Stop requested. Finishing the current step." : agent.task ?? (task ? "Task in progress." : agent.enabled ? "Ready for the next task." : "Paused.")}</p>
        {agent.target && <p className="of-muted">Target: {agent.target}</p>}
        {task && <p className="of-muted">{task.tools_used.length} step{task.tools_used.length === 1 ? "" : "s"} done{task.status === "running" ? ", more may follow" : ""}.</p>}
      </div>

      {partners.length > 0 && (
        <div>
          <h3>Working with</h3>
          <ul className="of-chips">{partners.map((slug) => <li key={slug}><button type="button" onClick={() => onSelect?.(slug)}><AgentFigure slug={slug} size={16} />{name(slug)}</button></li>)}</ul>
        </div>
      )}
      {toolsNow.length > 0 && (
        <div>
          <h3>Tools used in this task</h3>
          <ul className="of-chips">{toolsNow.map((tool) => <li key={tool} className="of-mono">{tool}</li>)}</ul>
        </div>
      )}

      {agent.errorMessage && agent.status === "error" && (
        <details className="of-error-box" role="alert" open>
          <summary>This agent failed</summary>
          <p className="of-error">{agent.errorMessage}</p>
        </details>
      )}
      {agent.pending.map((action) => <ApprovalBox key={action.id} action={action} hosts={hosts} onDone={onChanged} />)}

      {!agent.external && (
        <div className="of-ask">
          <label htmlFor="of-message">Send a message</label>
          <textarea id="of-message" aria-label={`Message ${agent.name}`} rows={2} value={message} disabled={!canMessage || sending} placeholder={canMessage ? `Ask ${agent.short} to handle a small job…` : "Resume this agent to send it a message."} onChange={(event) => setMessage(event.target.value)} />
          <Button variant="outline" disabled={!canMessage || sending || !message.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</Button>
          {reply && <p role="status" className="of-reply">{reply}</p>}
        </div>
      )}
      {agent.external && <p className="of-muted">Runs in an external runtime such as opencode. It reports its state here and takes no messages from Ops Center.</p>}

      <dl className="of-facts">
        <dt>Model</dt><dd>{config?.model ?? "Not configured"}</dd>
        <dt>Provider</dt><dd>{provider ?? "Not configured"}</dd>
      </dl>

      <details className="of-tools">
        <summary>Tools ({agent.skills.length})</summary>
        {agent.skills.length === 0 ? <p className="of-muted">No tools allowed.</p> : <ul>{agent.skills.map((tool) => <li key={tool}>{tool}</li>)}</ul>}
      </details>

      {actionError && <p role="alert" className="of-error">{actionError}</p>}
      <div className="of-actions of-actions-grid">
        {agent.external
          ? <Button asChild><Link to="/ai-agents/agents">Agents</Link></Button>
          : <Button asChild><Link to={`/ai-agents/chat?agent=${agent.slug}&from=ops-floor`}>Open chat</Link></Button>}
        <Button variant="outline" disabled={!task} onClick={() => task && onOpenTask?.(task.id)}>View task</Button>
        <Button variant="outline" disabled={agent.enabled || !hasRole("admin") || saving} onClick={() => void setEnabled(true)}>Resume</Button>
        <Button variant="destructive" disabled={!canStop || stopping} onClick={() => void stop()}>Stop task</Button>
      </div>
      {agent.enabled && hasRole("admin") && <button type="button" className="of-link-btn" disabled={saving} onClick={() => void setEnabled(false)}>Pause this agent</button>}

      <div>
        <h3>Recent activity</h3>
        {rows.length === 0 ? <p className="of-muted">Nothing recorded yet.</p> : (
          <ul className="of-mini-log">{rows.slice(0, 6).map((row) => (
            <li key={row.id}><time>{formatDayTime(row.ts)}</time><StatusGlyph status={row.kind} size={10} /><span>{row.text}</span></li>
          ))}</ul>
        )}
      </div>

      <div>
        <h3>Task history</h3>
        {history.length === 0 ? <p className="of-muted">No tasks yet.</p> : (
          <ul className="of-mini-log">{history.slice(0, 6).map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpenTask?.(item.id)}>
                <time>{formatDayTime(item.started_at ?? item.created_at)}</time>
                <span className={`of-tx-${item.status === "failed" ? "error" : item.status === "completed" ? "completed" : item.status === "cancelled" ? "paused" : "working"}`}>{item.status}</span>
                <span>{item.tools_used.length} steps</span>
              </button>
            </li>
          ))}</ul>
        )}
      </div>
    </aside>
  );
}
