import { useState } from "react";
import { Menu, Sparkles, ShieldCheck } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";

import { Sidebar } from "./Sidebar";

export function Layout() {
  const opsFloor = useLocation().pathname === "/ai-agents/ops-floor";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (opsFloor) return <Outlet />;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar open={mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:hidden">
          <button
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold tracking-wide">Ops Center</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="container max-w-none py-6">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Global "Ask Ops AI" entry point - available on every page, not
          just the AI Agents dashboard (spec: section 13). A full page (not
          a popup dialog) so a conversation with follow-up replies has room
          to breathe - see AIChat.tsx. */}
      <div className="fixed bottom-4 right-4 z-40">
        <Button size="lg" className="shadow-lg" asChild>
          <Link to="/ai-agents/chat">
            <Sparkles className="h-4 w-4" />
            Ask Ops AI
          </Link>
        </Button>
      </div>
    </div>
  );
}
