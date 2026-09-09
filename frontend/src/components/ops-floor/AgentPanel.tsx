import { MessageSquare, X } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { STATE_COLOR, STATE_LABEL, type AgentVisual } from "@/lib/opsFloorTypes";

import { RobotGlyph } from "./RobotGlyph";

const STATE_BADGE_VARIANT: Record<AgentVisual["state"], "ok" | "warning" | "critical" | "unknown"> = {
  idle: "unknown",
  walking: "unknown",
  working: "ok",
  investigating: "ok",
  waiting: "warning",
  success: "ok",
  error: "critical",
};

interface AgentPanelProps {
  agent: AgentVisual;
  onClose: () => void;
}

export function AgentPanel({ agent, onClose }: AgentPanelProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border border-border bg-card p-4 shadow-2xl sm:inset-auto sm:right-4 sm:top-24 sm:w-80 sm:rounded-xl">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <RobotGlyph color={agent.color} glow={STATE_COLOR[agent.state]} size={28} />
          <span className="font-semibold">{agent.name}</span>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant={STATE_BADGE_VARIANT[agent.state]}>{STATE_LABEL[agent.state]}</Badge>
          {agent.target && <span className="text-muted-foreground">{agent.target}</span>}
        </div>
        <p className="text-muted-foreground">{agent.activity}</p>
      </div>

      <div className="mt-4">
        <Button size="sm" className="w-full" asChild>
          <Link to={`/ai-agents/chat?agent=${agent.slug}`}>
            <MessageSquare className="h-3.5 w-3.5" />
            Talk to this agent
          </Link>
        </Button>
      </div>
    </div>
  );
}
