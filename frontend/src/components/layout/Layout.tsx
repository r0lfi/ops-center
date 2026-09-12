import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Search, Sparkles, ShieldCheck } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { InstallOpsCenter } from "@/components/PwaProvider";
import { Sidebar } from "./Sidebar";

function initialMenuOpen() {
  if (!window.matchMedia("(min-width: 768px)").matches) return false;
  try { return localStorage.getItem("ops_navigation_open") !== "false"; } catch { return true; }
}

export function Layout() {
  const opsFloor = useLocation().pathname === "/ai-agents/ops-floor";
  const [navOpen, setNavOpen] = useState(initialMenuOpen);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const edgeStart = useRef<number | null>(null);
  const focusSearch = useRef(false);
  const setOpen = useCallback((open: boolean) => {
    setNavOpen(open);
    if (window.matchMedia("(min-width: 768px)").matches) {
      try { localStorage.setItem("ops_navigation_open", String(open)); } catch { /* Storage may be unavailable. */ }
    }
  }, []);
  const close = useCallback(() => { setOpen(false); menuButton.current?.focus(); }, [setOpen]);
  const registerSearch = useCallback((input: HTMLInputElement | null) => { searchInput.current = input; }, []);
  function openSearch() {
    focusSearch.current = true;
    setOpen(true);
    if (navOpen) { searchInput.current?.focus(); focusSearch.current = false; }
  }
  useEffect(() => {
    if (navOpen && focusSearch.current) { searchInput.current?.focus(); focusSearch.current = false; }
  }, [navOpen]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const resize = () => setNavOpen(initialMenuOpen());
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);

  if (opsFloor) return <Outlet />;

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-background">
      <Sidebar open={navOpen} onClose={close} onSearchReady={registerSearch}
        onNavigate={() => { if (!window.matchMedia("(min-width: 768px)").matches) close(); }} />
      {navOpen && <button type="button" tabIndex={-1} aria-label="Close menu" className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden" onClick={close} />}
      {!navOpen && <div aria-hidden="true" className="fixed inset-y-16 left-0 z-30 w-3 touch-pan-y"
        onPointerDown={event => { edgeStart.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (edgeStart.current !== null && event.clientX - edgeStart.current > 65) { setOpen(true); edgeStart.current = null; } }}
        onPointerUp={event => { if (edgeStart.current !== null && event.clientX - edgeStart.current > 65) setOpen(true); edgeStart.current = null; }}
        onPointerCancel={() => { edgeStart.current = null; }} />}
      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-200 motion-reduce:transition-none", navOpen && "md:pl-72")}>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/60 bg-card/50 px-4 md:px-6">
          <button ref={menuButton} type="button" onClick={() => setOpen(!navOpen)} aria-expanded={navOpen} aria-controls="ops-navigation"
            aria-label={navOpen ? "Close menu" : "Open menu"} title="Show or hide menu"
            className="rounded-xl border border-border p-2.5 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><span className="text-sm font-semibold tracking-wide">Ops Center</span></div>
          <button type="button" onClick={openSearch} aria-label="Search menu" aria-controls="ops-navigation"
            className="ml-auto flex items-center gap-2 rounded-xl border border-border bg-background/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <Search className="h-4 w-4" /><span className="hidden sm:inline">Find a feature</span>
          </button>
          <InstallOpsCenter />
        </header>
        <main className="ops-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="container max-w-none py-6 pb-24"><Outlet /></div>
        </main>
      </div>
      <div className="fixed bottom-4 right-4 z-30">
        <Button size="lg" className="shadow-lg" asChild><Link to="/ai-agents/chat"><Sparkles className="h-4 w-4" />Ask Ops AI</Link></Button>
      </div>
    </div>
  );
}
