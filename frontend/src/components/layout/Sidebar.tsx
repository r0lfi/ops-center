import { useEffect, useRef, useState, type PointerEvent } from "react";
import { KeyRound,
  Code2,
  ChevronDown,
  ChevronLeft,
  Activity,
  Bell,
  Boxes,
  Camera,
  CheckSquare,
  ClipboardList,
  Cog,
  Ban,
  GitBranch,
  Globe,
  Route,
  Waypoints,
  FileText,
  Gauge,
  LayoutDashboard,
  Layers,
  ListChecks,
  LogOut,
  Network,
  Package,
  Pin,
  Radar,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Store,
  UserRound,
  Users,
  Wifi,
  Wrench,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "@/lib/auth";
import type { PaletteItem } from "@/lib/commandPalette";
import { useNavCounts } from "@/lib/navCounts";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: "alerts" | "approvals";
}

interface NavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}

const HOME: NavItem = { label: "Overview", to: "/", icon: Gauge };
const SETTINGS: NavItem = { label: "Settings", to: "/settings", icon: Cog };

const GROUPS: NavGroup[] = [
  { label: "Alerts & Incidents", icon: Bell, items: [
    { label: "Alerts", to: "/alerts", icon: Bell, count: "alerts" },
    { label: "Incidents", to: "/incidents", icon: ClipboardList },
  ] },
  { label: "Infrastructure", icon: Server, items: [
    { label: "Servers", to: "/servers", icon: Server },
    { label: "Monitoring", to: "/monitoring", icon: Activity },
    { label: "Services", to: "/services", icon: Layers },
    { label: "Logs", to: "/logs", icon: FileText },
    { label: "Traffic Map", to: "/traffic-map", icon: Radar },
    { label: "Cluster", to: "/cluster", icon: Network },
    { label: "VPN", to: "/vpn", icon: Wifi },
    { label: "Container hosts", to: "/containers", icon: Boxes },
    { label: "All containers", to: "/containers/all", icon: ListChecks },
    { label: "Registries", to: "/registries", icon: Package },
    { label: "App Catalog", to: "/app-catalog", icon: Store },
    { label: "Cameras", to: "/cameras", icon: Camera },
  ] },
  { label: "Security", icon: ShieldCheck, items: [
    { label: "Vulnerabilities", to: "/vulnerabilities", icon: ShieldAlert },
    { label: "Security Intelligence", to: "/security-intelligence", icon: ShieldCheck },
    { label: "Patching", to: "/patching", icon: Wrench },
    { label: "Patch Reports", to: "/patching/reports", icon: ClipboardList },
  ] },
  { label: "Automation", icon: ListChecks, items: [
    { label: "Run actions", to: "/automation", icon: ListChecks },
    { label: "Playbook Library", to: "/automation/playbooks", icon: FileText },
    { label: "Jobs", to: "/jobs", icon: ClipboardList },
  ] },
  { label: "AI Traffic Monitor", icon: Waypoints, items: [
    { label: "Traffic overview", to: "/ai-traffic", icon: Gauge },
    { label: "Live Traffic", to: "/ai-traffic/live", icon: Activity },
    { label: "Live Map", to: "/ai-traffic/map", icon: Globe },
    { label: "Blocked & Failed", to: "/ai-traffic/blocked", icon: Ban },
    { label: "Agent Trace", to: "/ai-traffic/trace", icon: Route },
    { label: "Network Flow", to: "/ai-traffic/flow", icon: GitBranch },
    { label: "Capture & Sources", to: "/ai-traffic/sources", icon: Globe },
  ] },
  { label: "AI", icon: Sparkles, items: [
    { label: "Ask Ops AI", to: "/ai-agents/chat", icon: Sparkles },
    { label: "AI overview", to: "/ai-agents", icon: LayoutDashboard },
    { label: "Agents", to: "/ai-agents/agents", icon: Users },
    { label: "Personal agent (Nova)", to: "/ai-agents/nova", icon: UserRound },
    { label: "Tasks", to: "/ai-agents/tasks", icon: CheckSquare },
    { label: "Approvals", to: "/ai-agents/approvals", icon: ClipboardList, count: "approvals" },
    { label: "Developer Agent", to: "/ai-agents/developer", icon: Code2 },
    { label: "MCP access", to: "/ai-agents/mcp-access", icon: KeyRound },
    { label: "Ops Floor", to: "/ai-agents/ops-floor", icon: Boxes },
    { label: "Agent Logs", to: "/ai-agents/agent-logs", icon: ScrollText },
    { label: "History & memory", to: "/ai-agents/memory", icon: FileText },
    { label: "Collaboration board", to: "/ai-agents/collaboration", icon: Users },
    { label: "Documentation", to: "/ai-agents/documentation", icon: FileText },
  ] },
];

const SETTINGS_TABS: [string, string, string][] = [
  ["incidents", "Incidents & Talk settings", "notifications"],
  ["traffic", "Traffic Map settings", ""],
  ["users", "Users", "accounts roles"],
  ["credentials", "Credentials", "ssh keys"],
  ["audit", "Audit log", "history"],
  ["ai", "AI providers & weekly budget", "settings models"],
  ["collaboration", "Collaboration settings", "permissions"],
  ["mcp", "MCP access", "clients tools"],
];

/** Every page the command palette can open, including the settings tabs. */
export const NAV_PAGES: PaletteItem[] = [
  ...[HOME, SETTINGS].map(item => ({ id: `page:${item.to}`, kind: "page" as const, label: item.label, to: item.to })),
  ...GROUPS.flatMap(group => group.items.map(item => ({ id: `page:${item.to}`, kind: "page" as const, label: item.label, hint: group.label, to: item.to }))),
  ...SETTINGS_TABS.map(([tab, label, keywords]) => ({ id: `page:settings/${tab}`, kind: "page" as const, label, hint: "Settings", keywords, to: `/settings?tab=${tab}` })),
];

const PIN_KEY = "ops-nav-pinned-groups";

const NAV_TARGETS = [SETTINGS.to, ...GROUPS.flatMap(group => group.items.map(item => item.to))];

// The most specific menu entry owns the page, so /containers/host-a marks
// Containers while /containers/all marks All containers.
function isActive(pathname: string, to: string) {
  if (pathname === to) return true;
  const owner = NAV_TARGETS.filter(target => pathname.startsWith(target + "/")).sort((a, b) => b.length - a.length)[0];
  return !NAV_TARGETS.includes(pathname) && owner === to;
}

function loadPinned(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  onNavigate: () => void;
}

export function Sidebar({ open, onClose, onNavigate }: SidebarProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const panel = useRef<HTMLElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const counts = useNavCounts();
  const [pinned, setPinned] = useState<string[]>(loadPinned);
  const current = GROUPS.find(group => group.items.some(item => isActive(location.pathname, item.to)))?.label;
  const [expanded, setExpanded] = useState<string[]>(() => [...pinned, ...(current ? [current] : [])]);
  // Moving to another group closes the others, except the ones the user pinned.
  useEffect(() => {
    setExpanded(current ? [...new Set([...pinned, current])] : pinned);
    // Pinning must not close a group the user opened by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useEffect(() => {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(pinned)); } catch { /* Storage can be unavailable. */ }
  }, [pinned]);
  function toggle(label: string) {
    setExpanded(value => value.includes(label) ? value.filter(v => v !== label) : [...value, label]);
  }
  function togglePin(label: string) {
    setPinned(value => value.includes(label) ? value.filter(v => v !== label) : [...value, label]);
    setExpanded(value => value.includes(label) ? value : [...value, label]);
  }
  // Keep the current page visible in a long menu.
  useEffect(() => {
    if (open) panel.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, location.pathname, expanded]);
  function countFor(item: NavItem) {
    return item.count ? counts[item.count] : 0;
  }

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
      className={cn("fixed inset-y-0 left-0 z-50 flex h-dvh w-72 max-w-[85vw] flex-col pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] border-r border-primary/10 bg-card shadow-2xl shadow-black/30 transition-[transform,visibility] duration-200 motion-reduce:transition-none",
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
          className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:hidden"><ChevronLeft className="h-5 w-5" /></button>
      </div>
      <nav aria-label="Features" className="ops-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 pb-6 pt-2" style={{ touchAction: "pan-y" }}>
        <NavEntry item={HOME} active={isActive(location.pathname, HOME.to)} onNavigate={onNavigate} />
        {GROUPS.map(group => {
          const isOpen = expanded.includes(group.label);
          const hasActive = group.items.some(item => isActive(location.pathname, item.to));
          const id = "nav-group-" + group.label.toLowerCase().replace(/[^a-z]+/g, "-");
          const isPinned = pinned.includes(group.label);
          // A closed group still tells you something inside it is waiting.
          const waiting = group.items.reduce((sum, item) => sum + countFor(item), 0);
          return <section key={group.label} aria-label={group.label} className="pt-1">
            <div className="group/header flex items-center gap-1">
              <button type="button" onClick={() => toggle(group.label)} aria-expanded={isOpen} aria-controls={id}
                className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  hasActive && !isOpen ? "text-primary" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground")}>
                <group.icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{group.label}</span>
                {!isOpen && waiting > 0 && <NavCount value={waiting} critical={group.items.some(item => item.count === "alerts") && counts.criticalAlerts > 0} label={`${waiting} waiting in ${group.label}`} />}
                <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none", isOpen ? "rotate-0" : "-rotate-90")} />
              </button>
              <button type="button" onClick={() => togglePin(group.label)} aria-pressed={isPinned} aria-label={`${isPinned ? "Unpin" : "Keep open:"} ${group.label}`} title={isPinned ? "Unpin this group" : "Keep this group open"}
                className={cn("shrink-0 rounded-lg p-1.5 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isPinned ? "text-primary" : "text-muted-foreground md:opacity-0 md:group-hover/header:opacity-100")}>
                <Pin className="h-3.5 w-3.5" />
              </button>
            </div>
            <div id={id} hidden={!isOpen} className="mt-0.5 space-y-0.5 border-l border-border/50 pl-2 ml-5">
              {group.items.map(item => <NavEntry key={item.to} item={item} active={isActive(location.pathname, item.to)} onNavigate={onNavigate}
                count={countFor(item)} critical={item.count === "alerts" && counts.criticalAlerts > 0} />)}
            </div>
          </section>;
        })}
        <div className="pt-1"><NavEntry item={SETTINGS} active={isActive(location.pathname, SETTINGS.to)} onNavigate={onNavigate} /></div>
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

function NavCount({ value, critical, label }: { value: number; critical?: boolean; label: string }) {
  return <span aria-label={label} title={label} className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold normal-case tabular-nums tracking-normal",
    critical ? "bg-status-critical/15 text-status-critical" : "bg-status-warning/15 text-status-warning")}>{value}</span>;
}

function NavEntry({ item, active, onNavigate, count = 0, critical }: { item: NavItem; active: boolean; onNavigate: () => void; count?: number; critical?: boolean }) {
  const Icon = item.icon;
  return <NavLink to={item.to} end onClick={onNavigate} data-active={active} aria-current={active ? "page" : undefined}
    className={cn("group flex items-center gap-3 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active ? "border-primary/20 bg-primary/10 text-primary shadow-sm" : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/60 hover:text-foreground")}>
    <Icon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{item.label}</span>
    {count > 0 && <NavCount value={count} critical={critical} label={`${count} ${item.count === "alerts" ? "active alerts" : "pending approvals"}`} />}
    {active && !count && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
  </NavLink>;
}
