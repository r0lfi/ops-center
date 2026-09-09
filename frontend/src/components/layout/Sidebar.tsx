import { Fragment } from "react";
import {
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
  { label: "Settings", to: "/settings", icon: Cog },
];

const AI_AGENTS_SUB_ITEMS: NavItem[] = [
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
  onNavigate: () => void;
}

function NavRow({ label, to, icon: Icon, onNavigate, end, indent }: NavItem & { onNavigate: () => void; end?: boolean; indent?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          indent && "py-1.5 pl-9 text-[13px]",
          isActive && "bg-accent text-foreground ring-1 ring-primary/40",
        )
      }
    >
      <Icon className={indent ? "h-3.5 w-3.5" : "h-4 w-4"} />
      {label}
    </NavLink>
  );
}

export function Sidebar({ open, onNavigate }: SidebarProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const aiSectionActive = location.pathname.startsWith("/ai-agents");

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex h-screen w-60 shrink-0 -translate-x-full flex-col border-r border-border bg-card transition-transform duration-200 ease-in-out md:static md:translate-x-0",
        open && "translate-x-0",
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-wide">Ops Center</div>
          <div className="text-[11px] text-muted-foreground">Infrastructure management</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS_BEFORE_AI.map((item) => (
          <Fragment key={item.to}>
            <NavRow {...item} onNavigate={onNavigate} end={item.to === "/" || item.to === "/patching" || item.to === "/automation"} />
            {item.to === "/automation" && <NavRow label="Playbook Library" to="/automation/playbooks" icon={FileText} onNavigate={onNavigate} indent />}
            {item.to === "/patching" && <NavRow label="Reports" to="/patching/reports" icon={ClipboardList} onNavigate={onNavigate} indent />}
          </Fragment>
        ))}

        <div>
          <NavLink
            to="/ai-agents"
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground",
              aiSectionActive ? "bg-accent text-foreground ring-1 ring-primary/40" : "text-muted-foreground",
            )}
          >
            <Sparkles className="h-4 w-4" />
            AI Agents
          </NavLink>
          {aiSectionActive && (
            <div className="mt-0.5 space-y-0.5 border-l border-border pl-1">
              {AI_AGENTS_SUB_ITEMS.map((item) => (
                <NavRow key={item.to} {...item} onNavigate={onNavigate} end={item.to === "/ai-agents"} indent />
              ))}
            </div>
          )}
        </div>

        {NAV_ITEMS_AFTER_AI.map((item) => (
          <Fragment key={item.to}>
            <NavRow {...item} onNavigate={onNavigate} end={item.to === "/containers"} />
            {item.to === "/containers" && <NavRow label="List all containers" to="/containers/all" icon={ListChecks} onNavigate={onNavigate} indent />}
          </Fragment>
        ))}
      </nav>
      <div className="border-t border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">{user?.username}</p>
            <p className="text-xs text-muted-foreground">{user?.role}</p>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
