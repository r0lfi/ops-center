import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { api, type AIAction, type AIAgent, type AITask } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Ask Ops AI conversation logic, shared by the full page (/ai-agents/chat)
 * and the floating assistant. History, conversation keys, approvals and
 * agent choice behave the same in both.
 */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1500;
const CONVERSATION_KEY_PREFIX = "ops_chat_conversation:";
/** Must match ASK_CONTEXT_MARK in backend/app/api/routes/ai.py. */
const CONTEXT_MARK = "\n\n---\nPage context";

export interface AskContext { page: string; path: string; items: { label: string; value: string }[] }

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  withContext?: boolean;
  task?: AITask;
  actions?: AIAction[];
  pending?: boolean;
}

// Browser fallback for an empty archive; existing conversations are restored from the server.
export function conversationKeyFor(agentSlug: string, userId: string): string {
  const storageKey = CONVERSATION_KEY_PREFIX + userId + ":" + agentSlug;
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const created = `web:${agentSlug}:${crypto.randomUUID()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    // private-mode/storage-blocked browsers - a per-page-load id still
    // works, it just won't survive a reload.
    return `web:${agentSlug}:${crypto.randomUUID()}`;
  }
}

export function newConversationKeyFor(agentSlug: string, userId: string): string {
  const created = `web:${agentSlug}:${crypto.randomUUID()}`;
  try {
    localStorage.setItem(CONVERSATION_KEY_PREFIX + userId + ":" + agentSlug, created);
  } catch {
    /* see conversationKeyFor */
  }
  return created;
}

function userText(input: string): { text: string; withContext: boolean } {
  const at = input.indexOf(CONTEXT_MARK);
  return at < 0 ? { text: input, withContext: false } : { text: input.slice(0, at), withContext: true };
}

export function useAgents(): AIAgent[] {
  const [agents, setAgents] = useState<AIAgent[]>([]);
  useEffect(() => { api.ai.agents.list().then(setAgents).catch(() => {}); }, []);
  return agents;
}

/** One conversation with one agent: restore, send, poll, answer approvals. */
export function useAskOpsConversation(agentSlug: string, requestedConversation: string) {
  const { user } = useAuth();
  const [conversationKey, setConversationKey] = useState(() => conversationKeyFor(agentSlug, user?.id || ""));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pollTask = useCallback((taskId: string, version: number) => {
    async function poll() {
      try {
        const task = await api.ai.tasks.get(taskId);
        if (version !== generation.current) return;
        if (!TERMINAL_STATUSES.has(task.status)) {
          pollRef.current = setTimeout(poll, POLL_MS);
          return;
        }
        const actions = await api.ai.actions.list("pending", 10, task.id).catch(() => []);
        if (version !== generation.current) return;
        setMessages(previous => previous.map(m => m.id === `${taskId}:assistant` ? {
          id: m.id, role: "assistant", text: task.response_message || task.error_message || "(no answer returned)", task, actions,
        } : m));
        setSending(false);
      } catch {
        if (version === generation.current) { setSending(false); setError("Connection interrupted. Reload to recover the saved conversation."); }
      }
    }
    pollRef.current = setTimeout(poll, POLL_MS);
  }, []);

  useEffect(() => {
    const version = ++generation.current;
    if (pollRef.current) clearTimeout(pollRef.current);
    setMessages([]); setError(null); setSending(false); setLoadingHistory(true); setHistoryReady(false); setHistoryCount(0);
    async function restore() {
      try {
        let key = requestedConversation;
        if (!key) {
          const recent = await api.ai.history({ agent: agentSlug, limit: 1 });
          key = recent.items[0]?.task.conversation_key || conversationKeyFor(agentSlug, user?.id || "");
        }
        const history = await api.ai.history({ agent: agentSlug, conversation_key: key, limit: 100 });
        if (version !== generation.current) return;
        setConversationKey(key); setHistoryCount(history.total); setHistoryReady(true);
        const restored: ChatMessage[] = history.items.slice().reverse().flatMap(({ task }) => [
          { id: `${task.id}:user`, role: "user" as const, ...userText(task.input_message) },
          { id: `${task.id}:assistant`, role: "assistant" as const, text: task.response_message || task.error_message || "", task, pending: !TERMINAL_STATUSES.has(task.status) },
        ]);
        setMessages(restored);
        const active = history.items.find(({ task }) => !TERMINAL_STATUSES.has(task.status));
        if (active) { setSending(true); pollTask(active.task.id, version); }
      } catch (err) {
        if (version === generation.current) setError(err instanceof Error ? err.message : "Could not load saved conversation.");
      } finally { if (version === generation.current) setLoadingHistory(false); }
    }
    void restore();
    // Bumping the generation is the point: late responses of this run are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++generation.current; if (pollRef.current) clearTimeout(pollRef.current); };
    // Each change starts an isolated request generation; late poll/history responses are ignored.
  }, [agentSlug, requestedConversation, user?.id, pollTask]);

  const send = useCallback(async (text: string, context?: AskContext | null): Promise<boolean> => {
    if (!text || sending || loadingHistory || !historyReady) return false;
    const version = generation.current;
    setSending(true); setError(null);
    try {
      const task = await api.ai.ask(text, agentSlug, conversationKey, context ?? undefined);
      if (version !== generation.current) return false;
      setMessages(previous => [...previous,
        { id: `${task.id}:user`, role: "user", text, withContext: !!context },
        { id: `${task.id}:assistant`, role: "assistant", text: "", pending: true, task },
      ]);
      pollTask(task.id, version);
      return true;
    } catch (err) {
      if (version === generation.current) { setSending(false); setError(err instanceof Error ? err.message : "Could not send message."); }
      return false;
    }
  }, [agentSlug, conversationKey, historyReady, loadingHistory, pollTask, sending]);

  const respond = useCallback(async (messageId: string, action: AIAction, decision: "approve" | "reject") => {
    setBusyActionId(action.id);
    try {
      const updated = await (decision === "approve" ? api.ai.actions.approve(action.id) : api.ai.actions.reject(action.id));
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, actions: (m.actions || []).map(a => (a.id === action.id ? updated : a)) } : m));
    } finally {
      setBusyActionId(null);
    }
  }, []);

  return { conversationKey, messages, loadingHistory, historyReady, historyCount, sending, busyActionId, error, send, respond };
}

const RISK_VARIANT: Record<string, "ok" | "warning" | "critical"> = { low: "ok", medium: "warning", high: "critical" };

export function ChatMessages({ chat, agentName, compact = false }: {
  chat: ReturnType<typeof useAskOpsConversation>; agentName?: string; compact?: boolean;
}) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const canApprove = hasRole("operator");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages]);

  return (
    <div ref={scrollRef} className={cn("ops-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto", compact ? "px-3 py-3" : "py-4")} aria-live="polite">
      {chat.loadingHistory && <p className="text-sm text-muted-foreground">Loading saved conversation…</p>}
      {chat.historyCount > 100 && <p className="text-xs text-muted-foreground">Showing the latest 100 exchanges. Older messages are searchable in History &amp; memory.</p>}
      {!chat.loadingHistory && chat.messages.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Ask {agentName || "an agent"} anything about your infrastructure - you can keep replying below to continue the conversation.
        </p>
      )}
      {chat.messages.map(m => (
        <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
          <div className={cn("rounded-lg px-3 py-2 text-sm", compact ? "max-w-[92%]" : "max-w-2xl",
            m.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-secondary/50")}>
            {m.pending ? <p className="text-muted-foreground">Investigating...</p> : <p className="whitespace-pre-wrap break-words">{m.text}</p>}
            {m.withContext && <p className="mt-1 text-[11px] opacity-75">with page context</p>}
            {m.task && (m.task.agents_used.length > 0 || m.task.tools_used.length > 0) && (
              <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                {m.task.agents_used.length > 0 && <p>Agents: {m.task.agents_used.join(", ")}</p>}
                {m.task.tools_used.length > 0 && <p>Tools: {m.task.tools_used.map(t => t.tool).join(", ")}</p>}
                {m.task.data_sources.length > 0 && <p>Data sources: {m.task.data_sources.join(", ")}</p>}
                {m.task.duration_ms != null && <p>{(m.task.duration_ms / 1000).toFixed(1)}s</p>}
              </div>
            )}
            {m.task?.status === "failed" && <Badge variant="critical" className="mt-2">failed</Badge>}
            {(m.actions || []).map(a => {
              const needsAdmin = a.approval_level >= 3;
              const canRespond = a.status === "pending" && canApprove && (!needsAdmin || isAdmin);
              return (
                <div key={a.id} className="mt-3 space-y-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={RISK_VARIANT[a.risk] ?? "unknown"}>L{a.approval_level} - {a.risk}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">{a.request_code}</span>
                  </div>
                  <p>{a.action}</p>
                  {a.status !== "pending" ? (
                    <Badge variant={a.status === "approved" ? "ok" : "unknown"}>{a.status}</Badge>
                  ) : canRespond ? (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={chat.busyActionId === a.id} onClick={() => chat.respond(m.id, a, "reject")}>Reject</Button>
                      <Button size="sm" disabled={chat.busyActionId === a.id} onClick={() => chat.respond(m.id, a, "approve")}>Approve</Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{needsAdmin ? "Requires an admin to approve." : "Requires an operator to approve."}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatComposer({ chat, onSend, compact = false, inputRef, placeholder }: {
  chat: ReturnType<typeof useAskOpsConversation>;
  onSend: (text: string) => Promise<boolean>;
  compact?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const disabled = chat.sending || chat.loadingHistory || !chat.historyReady;
  async function send() {
    const text = input.trim();
    if (!text || disabled) return;
    if (await onSend(text)) setInput("");
  }
  return (
    <div className={cn("flex items-end gap-2 border-t border-border", compact ? "p-2" : "pt-3")}>
      <textarea ref={inputRef} aria-label="Message"
        className={cn("w-full resize-y rounded-md border border-input bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "max-h-32 min-h-10" : "max-h-40 min-h-11")}
        rows={compact ? 1 : 2}
        placeholder={placeholder ?? "e.g. Why is ops-host slow? (Enter to send, Shift+Enter for a new line)"}
        value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
      <Button onClick={() => void send()} disabled={disabled || !input.trim()} aria-label="Send" size={compact ? "sm" : "default"} className={compact ? "h-10" : undefined}>
        <Send className="h-3.5 w-3.5" />{!compact && "Send"}
      </Button>
    </div>
  );
}

export function MemoryNote({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      History is saved locally. Selected history and memories are sent to the configured model when used. <Link to="/ai-agents/memory" className="text-primary">Manage memory</Link>
    </p>
  );
}
