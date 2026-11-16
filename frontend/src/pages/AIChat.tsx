import { ArrowLeft, RotateCcw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { ChatComposer, ChatMessages, MemoryNote, newConversationKeyFor, useAgents, useAskOpsConversation } from "@/components/ai/AskOpsChat";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";

/** Full-page Ask Ops AI. The floating assistant (AskOpsDock) shares the same conversation logic. */
export default function AIChat() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentSlug = searchParams.get("agent") || "coordinator";
  const fromOpsFloor = searchParams.get("from") === "ops-floor";
  const returnTo = fromOpsFloor ? "/ai-agents/ops-floor" : "/ai-agents";
  const requestedConversation = searchParams.get("conversation") || "";
  const agents = useAgents();
  const chat = useAskOpsConversation(agentSlug, requestedConversation);

  function switchAgent(slug: string) {
    setSearchParams({ agent: slug, ...(fromOpsFloor ? { from: "ops-floor" } : {}) });
  }

  function startNewConversation() {
    setSearchParams({ agent: agentSlug, conversation: newConversationKeyFor(agentSlug, user?.id || ""), ...(fromOpsFloor ? { from: "ops-floor" } : {}) });
  }

  const currentAgent = agents.find(a => a.slug === agentSlug);

  return (
    <div className="flex h-[80vh] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <Link to={returnTo} aria-label="Back" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
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
          <select aria-label="Agent" className="rounded-md border border-input bg-secondary px-2 py-1.5 text-sm text-foreground [color-scheme:dark]" value={agentSlug} onChange={e => switchAgent(e.target.value)}>
            {agents.map(a => <option key={a.slug} value={a.slug} className="bg-card text-foreground">{a.name}</option>)}
          </select>
        </div>
      </div>

      <MemoryNote className="py-2" />
      <ChatMessages chat={chat} agentName={currentAgent?.name} />
      {chat.error && <p className="pb-2 text-sm text-status-critical">{chat.error}</p>}
      <ChatComposer chat={chat} onSend={text => chat.send(text)} />
    </div>
  );
}
