import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Send } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { api, type AIAction, type AIAgent, type AITask } from "@/lib/api";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1500;
const CONVERSATION_KEY_PREFIX = "ops_chat_conversation:";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  task?: AITask;
  actions?: AIAction[];
  pending?: boolean;
}

// Browser fallback for an empty archive; existing conversations are restored from the server.
function conversationKeyFor(agentSlug: string, userId: string): string {
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

function newConversationKeyFor(agentSlug: string, userId: string): string {
  const created = `web:${agentSlug}:${crypto.randomUUID()}`;
  try {
    localStorage.setItem(CONVERSATION_KEY_PREFIX + userId + ":" + agentSlug, created);
  } catch {
    /* see conversationKeyFor */
  }
  return created;
}

const RISK_VARIANT: Record<string, "ok" | "warning" | "critical"> = {
  low: "ok",
  medium: "warning",
  high: "critical",
};

export default function AIChat() {
  const { hasRole, user } = useAuth();
  const isAdmin = hasRole("admin");
  const canApprove = hasRole("operator");

  const [searchParams, setSearchParams] = useSearchParams();
  const agentSlug = searchParams.get("agent") || "coordinator";
  const fromOpsFloor = searchParams.get("from") === "ops-floor";
  const returnTo = fromOpsFloor ? "/ai-agents/ops-floor" : "/ai-agents";
  const [conversationKey, setConversationKey] = useState(() => conversationKeyFor(agentSlug, user?.id || ""));

  const [agents, setAgents] = useState<AIAgent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const generation = useRef(0);
  const requestedConversation = searchParams.get("conversation") || "";
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.ai.agents.list().then(setAgents).catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function pollTask(taskId: string, version: number) {
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
  }

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
          { id: `${task.id}:user`, role: "user", text: task.input_message },
          { id: `${task.id}:assistant`, role: "assistant", text: task.response_message || task.error_message || "", task, pending: !TERMINAL_STATUSES.has(task.status) },
        ]);
        setMessages(restored);
        const active = history.items.find(({ task }) => !TERMINAL_STATUSES.has(task.status));
        if (active) { setSending(true); pollTask(active.task.id, version); }
      } catch (err) {
        if (version === generation.current) setError(err instanceof Error ? err.message : "Could not load saved conversation.");
      } finally { if (version === generation.current) setLoadingHistory(false); }
    }
    void restore();
    return () => { ++generation.current; if (pollRef.current) clearTimeout(pollRef.current); };
    // Each change starts an isolated request generation; late poll/history responses are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug, requestedConversation, user?.id]);

  function switchAgent(slug: string) {
    setSearchParams({ agent: slug, ...(fromOpsFloor ? { from: "ops-floor" } : {}) });
  }

  function startNewConversation() {
    setSearchParams({ agent: agentSlug, conversation: newConversationKeyFor(agentSlug, user?.id || ""), ...(fromOpsFloor ? { from: "ops-floor" } : {}) });
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || loadingHistory || !historyReady) return;
    const version = generation.current;
    setSending(true); setError(null);
    try {
      const task = await api.ai.ask(text, agentSlug, conversationKey);
      if (version !== generation.current) return;
      setInput("");
      setMessages(previous => [...previous,
        { id: `${task.id}:user`, role: "user", text },
        { id: `${task.id}:assistant`, role: "assistant", text: "", pending: true, task },
      ]);
      pollTask(task.id, version);
    } catch (err) {
      if (version === generation.current) { setSending(false); setError(err instanceof Error ? err.message : "Could not send message."); }
    }
  }

  async function respond(messageId: string, action: AIAction, decision: "approve" | "reject") {
    setBusyActionId(action.id);
    try {
      const updated = await (decision === "approve" ? api.ai.actions.approve(action.id) : api.ai.actions.reject(action.id));
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, actions: (m.actions || []).map((a) => (a.id === action.id ? updated : a)) } : m,
        ),
      );
    } finally {
      setBusyActionId(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const currentAgent = agents.find((a) => a.slug === agentSlug);

  return (
    <div className="flex h-[80vh] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <Link to={returnTo} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold leading-tight">{currentAgent?.name || "Ask Ops AI"}</h1>
            <p className="text-xs text-muted-foreground">
              {currentAgent?.description || "Ask a question, then keep replying to continue the conversation."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline"><Link to="/ai-agents/memory">History &amp; memory</Link></Button>
          <Button size="sm" variant="outline" onClick={startNewConversation} title="Start a new thread. Saved history and long-term memory are kept.">
            <RotateCcw className="h-3.5 w-3.5" />
            New conversation
          </Button>
          <select
            className="rounded-md border border-input bg-secondary px-2 py-1.5 text-sm"
            value={agentSlug}
            onChange={(e) => switchAgent(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="py-2 text-xs text-muted-foreground">History is saved locally. Selected history and memories are sent to the configured model when used. <Link to="/ai-agents/memory" className="text-primary">Manage memory</Link></p>
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto py-4">
        {loadingHistory && <p className="text-sm text-muted-foreground">Loading saved conversation…</p>}
        {historyCount > 100 && <p className="text-xs text-muted-foreground">Showing the latest 100 exchanges. Older messages are searchable in History &amp; memory.</p>}
        {!loadingHistory && messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask {currentAgent?.name || "an agent"} anything about your infrastructure - you can keep replying below to continue the
            conversation.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-2xl rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-secondary/50"
              }`}
            >
              {m.pending ? (
                <p className="text-muted-foreground">Investigating...</p>
              ) : (
                <p className="whitespace-pre-wrap">{m.text}</p>
              )}
              {m.task && (m.task.agents_used.length > 0 || m.task.tools_used.length > 0) && (
                <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
                  {m.task.agents_used.length > 0 && <p>Agents: {m.task.agents_used.join(", ")}</p>}
                  {m.task.tools_used.length > 0 && <p>Tools: {m.task.tools_used.map((t) => t.tool).join(", ")}</p>}
                  {m.task.data_sources.length > 0 && <p>Data sources: {m.task.data_sources.join(", ")}</p>}
                  {m.task.duration_ms != null && <p>{(m.task.duration_ms / 1000).toFixed(1)}s</p>}
                </div>
              )}
              {m.task?.status === "failed" && (
                <Badge variant="critical" className="mt-2">
                  failed
                </Badge>
              )}

              {(m.actions || []).map((a) => {
                const needsAdmin = a.approval_level >= 3;
                const canRespond = a.status === "pending" && canApprove && (!needsAdmin || isAdmin);
                return (
                  <div key={a.id} className="mt-3 space-y-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5">
                    <div className="flex items-center gap-2">
                      <Badge variant={RISK_VARIANT[a.risk] ?? "unknown"}>
                        L{a.approval_level} - {a.risk}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">{a.request_code}</span>
                    </div>
                    <p>{a.action}</p>
                    {a.status !== "pending" ? (
                      <Badge variant={a.status === "approved" ? "ok" : "unknown"}>{a.status}</Badge>
                    ) : canRespond ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyActionId === a.id}
                          onClick={() => respond(m.id, a, "reject")}
                        >
                          Reject
                        </Button>
                        <Button size="sm" disabled={busyActionId === a.id} onClick={() => respond(m.id, a, "approve")}>
                          Approve
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {needsAdmin ? "Requires an admin to approve." : "Requires an operator to approve."}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="pb-2 text-sm text-status-critical">{error}</p>}

      <div className="flex items-end gap-2 border-t border-border pt-3">
        <textarea
          className="min-h-11 max-h-40 w-full resize-y rounded-md border border-input bg-secondary px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="e.g. Why is ops-host slow? (Enter to send, Shift+Enter for a new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button onClick={send} disabled={sending || loadingHistory || !historyReady || !input.trim()}>
          <Send className="h-3.5 w-3.5" />
          Send
        </Button>
      </div>
    </div>
  );
}
