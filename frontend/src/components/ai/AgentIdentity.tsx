import { Activity, BookOpen, ClipboardCheck, Code, Container, Cpu, FileSearch, GitBranch, MessageSquare, Network, PackageCheck, ShieldCheck, Terminal, UserRound, Waypoints, Workflow, type LucideIcon } from "lucide-react";
import type { AIAgent } from "@/lib/api";
import { STATIONS } from "@/lib/opsFloorTypes";
import { AgentFigure } from "@/components/ops-floor/AgentFigure";

const ICONS: Record<string, LucideIcon> = {
  coordinator: GitBranch, monitoring: Activity, linux: Terminal,
  security: ShieldCheck, network: Network, container: Container,
  patching: PackageCheck, automation: Workflow, chat: MessageSquare, general: FileSearch, nova: UserRound,
  "ext-coordinator": Waypoints, "ext-coder": Code, "ext-reader": BookOpen, "ext-reviewer": ClipboardCheck,
};

/** The icon for what the agent does, next to its figure. */
export function roleIcon(slug: string): LucideIcon {
  return ICONS[slug] ?? Cpu;
}

export function agentLabel(slug: string, agents: AIAgent[] = []): string {
  return STATIONS.find(station => station.slug === slug)?.label
    || agents.find(agent => agent.slug === slug)?.name
    || slug.replaceAll("_", " ").replaceAll("-", " ");
}
export function agentColor(slug: string): string {
  return STATIONS.find(station => station.slug === slug)?.color || "#91a6bd";
}

/** The agent's figure from the 3D office, so it looks the same on every page. */
export function AgentBadge({ slug, size = 36 }: { slug: string; size?: number }) {
  const color = agentColor(slug);
  return <span role="img" aria-label={`${agentLabel(slug)} agent`} style={{ display: "inline-grid", placeItems: "center", flexShrink: 0,
    width: size, height: size, borderRadius: Math.max(7, Math.round(size * .26)),
    border: `1px solid ${color}45`, background: `${color}12` }}>
    <AgentFigure slug={slug} size={Math.round(size * .78)} />
  </span>;
}
