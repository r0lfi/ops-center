import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

import type { AskContext } from "@/components/ai/AskOpsChat";
import { NAV_PAGES } from "@/components/layout/Sidebar";

export type AskMode = "closed" | "float" | "min" | "large" | "docked";
export interface AskDockState { mode: AskMode; restore: Exclude<AskMode, "closed" | "min">; x: number | null; y: number | null; agent: string }

type Item = { label: string; value: string };
interface AskOpsValue {
  dock: AskDockState;
  setDock: (update: Partial<AskDockState>) => void;
  pageItems: Item[];
  setPageItems: (items: Item[] | null) => void;
}

const STORAGE_KEY = "ops_ask_dock";
const DEFAULT: AskDockState = { mode: "closed", restore: "float", x: null, y: null, agent: "coordinator" };
const AskOpsCtx = createContext<AskOpsValue | null>(null);

function load(): AskDockState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    // The assistant never opens by itself on a new page load; only the layout choice is remembered.
    return { ...DEFAULT, ...saved, mode: "closed" };
  } catch { return DEFAULT; }
}

/** Floating assistant layout (mode, position, agent) and what the current page offers as context. UI state only. */
export function AskOpsProvider({ children }: { children: ReactNode }) {
  const [dock, setState] = useState<AskDockState>(load);
  const [pageItems, setItems] = useState<Item[]>([]);
  const value = useMemo<AskOpsValue>(() => ({
    dock,
    setDock: update => setState(prev => {
      const next = { ...prev, ...update };
      if (update.mode && update.mode !== "closed" && update.mode !== "min") next.restore = update.mode;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ restore: next.restore, x: next.x, y: next.y, agent: next.agent })); } catch { /* optional */ }
      return next;
    }),
    pageItems,
    setPageItems: items => setItems(items ?? []),
  }), [dock, pageItems]);
  return <AskOpsCtx.Provider value={value}>{children}</AskOpsCtx.Provider>;
}

export function useAskOps(): AskOpsValue {
  const ctx = useContext(AskOpsCtx);
  if (!ctx) throw new Error("useAskOps must be used within AskOpsProvider");
  return ctx;
}

/**
 * Pages offer what the user is looking at: the selected object, filters,
 * the time window. Identifiers and labels only, never data such as log
 * lines or secrets; the agent reads data with its own tools and permissions.
 */
export function useAskOpsPageContext(items: (Item | null | false | undefined)[]) {
  const ctx = useContext(AskOpsCtx);
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!ctx) return;
    ctx.setPageItems((JSON.parse(key) as (Item | null)[]).filter((i): i is Item => !!i && !!i.value).slice(0, 12)
      .map(i => ({ label: i.label.slice(0, 40), value: String(i.value).slice(0, 200) })));
    return () => ctx.setPageItems(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

const SENSITIVE_PARAM = /token|key|secret|pass|auth|session|cookie/i;

/** The context sent with a question: page name, route with its filters, and the page's own items. */
export function useCurrentAskContext(): AskContext {
  const { pathname, search } = useLocation();
  const { pageItems } = useAskOps();
  return useMemo(() => {
    const page = NAV_PAGES.filter(p => p.to && (pathname === p.to.split("?")[0] || pathname.startsWith(p.to.split("?")[0] + "/")))
      .sort((a, b) => (b.to?.length ?? 0) - (a.to?.length ?? 0))[0];
    const params = new URLSearchParams(search);
    for (const key of [...params.keys()]) if (SENSITIVE_PARAM.test(key)) params.delete(key);
    const query = params.toString();
    const filters: Item[] = [...params.entries()].slice(0, 6).map(([label, value]) => ({ label: label.slice(0, 40), value: value.slice(0, 200) }));
    return {
      page: (page?.label ?? (pathname === "/" ? "Overview" : pathname.split("/")[1] || "Ops Center")).slice(0, 80),
      path: (pathname + (query ? "?" + query : "")).slice(0, 300),
      items: [...pageItems, ...filters.filter(f => !pageItems.some(i => i.label === f.label))].slice(0, 12),
    };
  }, [pathname, search, pageItems]);
}
