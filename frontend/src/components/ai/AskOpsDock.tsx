import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ExternalLink, Maximize2, Minimize2, Minus, PanelRight, PanelRightClose, RotateCcw, Sparkles, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { ChatComposer, ChatMessages, newConversationKeyFor, useAgents, useAskOpsConversation } from "@/components/ai/AskOpsChat";
import { Button } from "@/components/ui/button";
import { Listbox } from "@/components/ui/listbox";
import { useAuth } from "@/lib/auth";
import { useAskOps, useCurrentAskContext, type AskMode } from "@/lib/askOps";
import { cn } from "@/lib/utils";

const FLOAT_W = 384, FLOAT_H = 540, MARGIN = 16;

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setMatch(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [query]);
  return match;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} onPointerDown={e => e.stopPropagation()}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {children}
    </button>
  );
}

/** The panel itself; mounted only while open or minimized, so the conversation survives minimizing. */
function Panel({ mode, wide }: { mode: AskMode; wide: boolean }) {
  const { user } = useAuth();
  const { dock, setDock } = useAskOps();
  const agents = useAgents();
  const [conversation, setConversation] = useState("");
  const chat = useAskOpsConversation(dock.agent, conversation);
  const context = useCurrentAskContext();
  const [useContextOnce, setUseContext] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const { pathname } = useLocation();

  // A new page offers its context again.
  useEffect(() => setUseContext(true), [pathname]);
  useEffect(() => { if (mode !== "min") inputRef.current?.focus(); }, [mode]);

  const floating = mode === "float" && wide;
  const pos = (() => {
    const w = FLOAT_W, h = Math.min(FLOAT_H, window.innerHeight - 2 * MARGIN);
    const x = dock.x ?? window.innerWidth - w - MARGIN, y = dock.y ?? window.innerHeight - h - MARGIN;
    return { x: Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN)), y: Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN)), w, h };
  })();

  function startDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!floating || e.button !== 0) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setDock({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
  }

  const agentName = agents.find(a => a.slug === dock.agent)?.name;
  const fullPage = `/ai-agents/chat?agent=${encodeURIComponent(dock.agent)}&conversation=${encodeURIComponent(chat.conversationKey)}`;
  const shell = !wide
    ? "inset-x-0 bottom-0 h-[78dvh] rounded-t-2xl border-t"
    : mode === "docked" ? "inset-y-0 right-0 w-[26rem] border-l"
      : mode === "large" ? "bottom-4 right-4 h-[min(82vh,52rem)] w-[min(48rem,calc(100vw-2rem))] rounded-xl border"
        : "rounded-xl border";

  return (
    <section role="dialog" aria-label="Ask Ops AI" aria-modal="false"
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setDock({ mode: "min" }); } }}
      className={cn("fixed z-40 flex flex-col border-border bg-card shadow-2xl shadow-black/40", shell, mode === "min" && "hidden")}
      style={floating ? { left: pos.x, top: pos.y, width: pos.w, height: pos.h } : undefined}>
      <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        className={cn("flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5", floating && "cursor-grab touch-none active:cursor-grabbing")}>
        <Sparkles className="ml-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 max-w-[13rem] flex-1" onPointerDown={e => e.stopPropagation()}>
          <Listbox label="Agent" value={dock.agent}
            options={agents.length ? agents.filter(a => a.enabled).map(a => ({ value: a.slug, label: a.name, description: a.description })) : [{ value: dock.agent, label: "Ask Ops AI" }]}
            onChange={slug => { setConversation(""); setDock({ agent: slug }); }} />
        </span>
        {chat.sending && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" title="Working" />}
        <span className="ml-auto flex shrink-0 items-center">
          <IconButton label="New conversation" onClick={() => setConversation(newConversationKeyFor(dock.agent, user?.id || ""))}><RotateCcw className="h-3.5 w-3.5" /></IconButton>
          {wide && mode !== "docked" && (mode === "large"
            ? <IconButton label="Smaller window" onClick={() => setDock({ mode: "float" })}><Minimize2 className="h-3.5 w-3.5" /></IconButton>
            : <IconButton label="Larger window" onClick={() => setDock({ mode: "large" })}><Maximize2 className="h-3.5 w-3.5" /></IconButton>)}
          {wide && (mode === "docked"
            ? <IconButton label="Undock (float)" onClick={() => setDock({ mode: "float" })}><PanelRightClose className="h-3.5 w-3.5" /></IconButton>
            : <IconButton label="Pin as side panel" onClick={() => setDock({ mode: "docked" })}><PanelRight className="h-3.5 w-3.5" /></IconButton>)}
          <Link to={fullPage} aria-label="Open full page" title="Open full page" onPointerDown={e => e.stopPropagation()}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></Link>
          <IconButton label="Minimize" onClick={() => setDock({ mode: "min" })}><Minus className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Close" onClick={() => setDock({ mode: "closed" })}><X className="h-3.5 w-3.5" /></IconButton>
        </span>
      </div>

      <ChatMessages chat={chat} agentName={agentName} compact />
      {chat.error && <p role="alert" className="px-3 pb-1 text-xs text-status-critical">{chat.error}</p>}

      <div className="flex min-h-8 items-center gap-1.5 px-3 pt-1 text-xs text-muted-foreground">
        {useContextOnce ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-primary"
            title={[context.path, ...context.items.map(i => `${i.label}: ${i.value}`)].join("\n")}>
            <span className="truncate">Context: {context.page}{context.items.length ? ` · ${context.items.length} detail${context.items.length === 1 ? "" : "s"}` : ""}</span>
            <button type="button" aria-label="Ask without page context" className="rounded-full p-0.5 hover:bg-primary/20" onClick={() => setUseContext(false)}><X className="h-3 w-3" /></button>
          </span>
        ) : (
          <button type="button" className="rounded-full border border-dashed border-border px-2 py-0.5 hover:text-foreground" onClick={() => setUseContext(true)}>+ Add page context</button>
        )}
      </div>
      <ChatComposer chat={chat} compact inputRef={inputRef} placeholder={`Ask about ${context.page}… (Enter to send)`}
        onSend={text => chat.send(text, useContextOnce ? context : null)} />
    </section>
  );
}

/** Ask Ops AI as a floating assistant: compact window, minimized pill, large window or pinned side panel. */
export function AskOpsDock() {
  const { dock, setDock } = useAskOps();
  const wide = useMedia("(min-width: 768px)");
  // Docking needs room beside the content; narrower screens use the large sheet.
  const mode: AskMode = dock.mode === "docked" && !wide ? "large" : dock.mode;

  return (
    <>
      {dock.mode !== "closed" && <Panel mode={mode} wide={wide} />}
      {(dock.mode === "closed" || dock.mode === "min") && (
        <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-30">
          <Button size="lg" className="h-11 w-11 p-0 shadow-lg sm:h-10 sm:w-auto sm:px-6" aria-label={dock.mode === "min" ? "Restore Ask Ops AI" : "Ask Ops AI"}
            title="Ask Ops AI" onClick={() => setDock({ mode: dock.restore })}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{dock.mode === "min" ? "Ask Ops AI · minimized" : "Ask Ops AI"}</span>
          </Button>
        </div>
      )}
    </>
  );
}
