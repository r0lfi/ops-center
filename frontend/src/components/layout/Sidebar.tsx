import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  Search,
  X,
  ChevronLeft,
  Activity,
  AlertTriangle,
  Bell,
  Boxes,
  Camera,
  CheckSquare,
  ClipboardList,
  Cog,
  FileText,
  Gauge,
  LayoutDashboard,
  Layers,
  ListChecks,
  LogOut,
  Network,
  Package,
  Radar,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Store,
  Users,
  Wifi,
  Wrench,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS_BEFORE_AI: NavItem[] = [
  { label: "Overview", to: "/", icon: Gauge },
  { label: "Servers", to: "/servers", icon: Server },
  { label: "Services", to: "/services", icon: Layers },
  { label: "Monitoring", to: "/monitoring", icon: Activity },
  { label: "Traffic Map", to: "/traffic-map", icon: Radar },
  { label: "Alerts", to: "/alerts", icon: Bell },
  { label: "Cameras", to: "/cameras", icon: Camera },
  { label: "Patching", to: "/patching", icon: Wrench },
  { label: "Vulnerabilities", to: "/vulnerabilities", icon: ShieldAlert },
  { label: "Security Intelligence", to: "/security-intelligence", icon: ShieldCheck },
  { label: "Automation", to: "/automation", icon: ListChecks },
];

const NAV_ITEMS_AFTER_AI: NavItem[] = [
  { label: "Containers", to: "/containers", icon: Boxes },
  { label: "Registries", to: "/registries", icon: Package },
  { label: "App Catalog", to: "/app-catalog", icon: Store },
  { label: "Logs", to: "/logs", icon: FileText },
  { label: "Jobs", to: "/jobs", icon: AlertTriangle },
  { label: "Cluster", to: "/cluster", icon: Network },
  { label: "VPN", to: "/vpn", icon: Wifi },
  { label: "MCP access", to: "/mcp-access", icon: Cog },
  { label: "Settings", to: "/settings", icon: Cog },
];

const AI_AGENTS_SUB_ITEMS: NavItem[] = [
  { label: "Documentation", to: "/ai-agents/documentation", icon: FileText },
  { label: "Collaboration board", to: "/ai-agents/collaboration", icon: Users },
  { label: "Collaboration settings", to: "/ai-agents/collaboration/settings", icon: Cog },
  { label: "History & memory", to: "/ai-agents/memory", icon: FileText },
  { label: "Dashboard", to: "/ai-agents", icon: LayoutDashboard },
  { label: "Agents", to: "/ai-agents/agents", icon: Users },
  { label: "Ops Floor", to: "/ai-agents/ops-floor", icon: Boxes },
  { label: "Tasks", to: "/ai-agents/tasks", icon: CheckSquare },
  { label: "Approvals", to: "/ai-agents/approvals", icon: ClipboardList },
  { label: "Agent Logs", to: "/ai-agents/agent-logs", icon: ScrollText },
  { label: "Settings", to: "/ai-agents/settings", icon: Cog },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNavigate: () => void;
  onSearchReady: (input: HTMLInputElement | null) => void;
}

const GROUPS = [
  { label: "Operations and monitoring", items: [...NAV_ITEMS_BEFORE_AI,
    { label: "Patch Reports", to: "/patching/reports", icon: ClipboardList },
    { label: "Playbook Library", to: "/automation/playbooks", icon: FileText }] },
  { label: "AI Agents", items: [
    { label: "Ask Ops AI / Chat", to: "/ai-agents/chat", icon: Sparkles }, ...AI_AGENTS_SUB_ITEMS] },
  { label: "Platform and administration", items: [...NAV_ITEMS_AFTER_AI,
    { label: "List all containers", to: "/containers/all", icon: ListChecks }] },
];

export function Sidebar({ open, onClose, onNavigate, onSearchReady }: SidebarProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const panel = useRef<HTMLElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const groups = GROUPS.map(group => ({ ...group, items: group.items.filter(item =>
    `${group.label} ${item.label} ${item.to}`.toLocaleLowerCase().includes(needle))
  })).filter(group => group.items.length);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    if (window.matchMedia("(max-width: 767px)").matches) {
      panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        previous?.focus();
      }
      if (event.key !== "Tab" || !window.matchMedia("(max-width: 767px)").matches) return;
      const elements = panel.current?.querySelectorAll<HTMLElement>('a[href], button, input');
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  function finishDrag(event: PointerEvent<HTMLElement>) {
    const origin = start.current;
    if (origin && origin.x - event.clientX > 65 && Math.abs(origin.y - event.clientY) < 60) {
      start.current = null;
      onClose();
    }
  }

  return (
    <aside ref={panel} id="ops-navigation" aria-label="Main navigation" aria-hidden={!open}
      className={cn("fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] flex-col border-r border-primary/10 bg-card shadow-2xl shadow-black/30 transition-[transform,visibility] duration-200 motion-reduce:transition-none",
        open ? "visible translate-x-0" : "invisible -translate-x-full")}
      onPointerDown={event => { start.current = { x: event.clientX, y: event.clientY }; }}
      style={{ touchAction: "pan-y" }} onPointerMove={finishDrag}
      onPointerUp={event => { finishDrag(event); start.current = null; }} onPointerCancel={() => { start.current = null; }}>
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border/60 px-5">
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-primary/20 bg-primary/10 p-2"><ShieldCheck className="h-5 w-5 text-primary" /></div>
          <div><div className="text-sm font-semibold tracking-wide">Ops Center</div><div className="text-[11px] text-muted-foreground">Infrastructure management</div></div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close menu" title="Close or drag the menu to the left"
          className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><ChevronLeft className="h-5 w-5" /></button>
      </div>
      <div className="shrink-0 px-4 pb-2 pt-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input ref={onSearchReady} type="search" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search menu"
            placeholder="Search all features …" className="h-10 w-full rounded-xl border border-border bg-background/60 pl-9 pr-9 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/10" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear menu search" className="absolute right-1 top-1 rounded-lg p-2 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
        </div>
      </div>
      <nav aria-label="Features" className="ops-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 pb-6 pt-3" style={{ touchAction: "pan-y" }}>
        {groups.map(group => <section key={group.label} aria-label={group.label}>
          <h2 className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{group.label}</h2>
          <div className="space-y-1">{group.items.map(({ label, to, icon: Icon }) => {
            const active = location.pathname === to || (to === "/servers" && location.pathname.startsWith("/servers/"));
            return <NavLink key={to} to={to} end onClick={onNavigate}
              className={cn("group flex items-center gap-3 rounded-xl border px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "border-primary/20 bg-primary/10 text-primary shadow-sm" : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/60 hover:text-foreground")}>
              <Icon className="h-4 w-4 shrink-0" /><span>{label}</span>
              {active && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            </NavLink>;
          })}</div>
        </section>)}
        {!groups.length && <p role="status" className="px-3 py-6 text-sm text-muted-foreground">No results. Try another search term.</p>}
      </nav>
      <div className="shrink-0 border-t border-border/60 bg-background/30 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold uppercase text-primary">{user?.username?.slice(0, 2)}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{user?.username}</p><p className="text-[11px] text-muted-foreground">{user?.role}</p></div>
          <button type="button" onClick={logout} aria-label="Sign out" title="Sign out" className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </aside>
  );
}
