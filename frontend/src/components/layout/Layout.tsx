import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Search, ShieldCheck } from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";

import { AskOpsDock } from "@/components/ai/AskOpsDock";
import { AskOpsProvider, useAskOps } from "@/lib/askOps";
import { cn } from "@/lib/utils";
import { InstallOpsCenter } from "@/components/PwaProvider";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";

function initialMenuOpen() {
  if (!window.matchMedia("(min-width: 768px)").matches) return false;
  try { return localStorage.getItem("ops_navigation_open") !== "false"; } catch { return true; }
}

export function Layout() {
  return <AskOpsProvider><LayoutShell /></AskOpsProvider>;
}

function LayoutShell() {
  const docked = useAskOps().dock.mode === "docked";
  const pathname = useLocation().pathname;
  const opsFloor = pathname === "/ai-agents/ops-floor";
  const collaboration = pathname === "/ai-agents/collaboration";
  const [navOpen, setNavOpen] = useState(initialMenuOpen);
  const menuButton = useRef<HTMLButtonElement>(null);
  const edgeStart = useRef<number | null>(null);
  const setOpen = useCallback((open: boolean) => {
    setNavOpen(open);
    if (window.matchMedia("(min-width: 768px)").matches) {
      try { localStorage.setItem("ops_navigation_open", String(open)); } catch { /* Storage may be unavailable. */ }
    }
  }, []);
  const close = useCallback(() => { setOpen(false); menuButton.current?.focus(); }, [setOpen]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const resize = () => setNavOpen(initialMenuOpen());
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);

  useEffect(() => { setNavOpen(collaboration ? false : initialMenuOpen()); }, [collaboration]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // The full chat page and the collaboration board have their own conversation UI.
  const showAsk = !collaboration && !pathname.startsWith("/ai-agents/chat");
  const palette = <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />;

  if (opsFloor) return <><Outlet />{palette}</>;

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-background">
      <Sidebar open={navOpen} onClose={close}
        onNavigate={() => { if (!window.matchMedia("(min-width: 768px)").matches) close(); }} />
      {navOpen && <button type="button" tabIndex={-1} aria-label="Close menu" className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden" onClick={close} />}
      {!navOpen && <div aria-hidden="true" className="fixed inset-y-16 left-0 z-30 w-3 touch-pan-y"
        onPointerDown={event => { edgeStart.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (edgeStart.current !== null && event.clientX - edgeStart.current > 65) { setOpen(true); edgeStart.current = null; } }}
        onPointerUp={event => { if (edgeStart.current !== null && event.clientX - edgeStart.current > 65) setOpen(true); edgeStart.current = null; }}
        onPointerCancel={() => { edgeStart.current = null; }} />}
      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-200 motion-reduce:transition-none", navOpen && "md:pl-72", showAsk && docked && "md:pr-[26rem]")}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-card/50 px-3 sm:gap-3 sm:px-4 md:h-16 md:px-6">
          <button ref={menuButton} type="button" onClick={() => setOpen(!navOpen)} aria-expanded={navOpen} aria-controls="ops-navigation"
            aria-label={navOpen ? "Close menu" : "Open menu"} title="Show or hide menu"
            className="rounded-xl border border-border p-2.5 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
            <Menu className="h-5 w-5" />
          </button>
          {/* The open menu already carries the logo and name. */}
          {!navOpen && <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><span className="text-sm font-semibold tracking-wide">Ops Center</span></div>}
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Search Ops Center" aria-keyshortcuts="Control+K Meta+K"
            className="ml-auto flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Search className="h-4 w-4" /><span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-border px-1.5 text-[11px] sm:inline">{/mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <InstallOpsCenter />
        </header>
        <main className="ops-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className={collaboration ? "p-2 pb-6 sm:p-4" : "container max-w-none py-6 pb-24"}><Outlet /></div>
        </main>
      </div>
      {palette}
      {showAsk && <AskOpsDock />}
    </div>
  );
}
