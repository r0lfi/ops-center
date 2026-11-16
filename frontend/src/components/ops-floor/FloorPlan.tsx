import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import { roleIcon } from "@/components/ai/AgentIdentity";
import type { FloorLayout } from "@/lib/opsFloor/config";
import { MOTION_LABEL, STATUS_LABEL, type FloorAgent, type FloorEdge, type FloorFlow } from "@/lib/opsFloor/model";

import { AgentFigure } from "./AgentFigure";
import { StatusGlyph } from "./StatusGlyph";
import { useReducedMotion } from "./useReducedMotion";
import "./ops-floor.css";

/** A line someone can click: the two agents and, when a task made it, that task. */
export interface FloorLink { from: string; to: string; taskId?: string | null }

interface FloorPlanProps {
  agents: FloorAgent[];
  layout: FloorLayout;
  edges: FloorEdge[];
  flows?: FloorFlow[];
  selected: string | null;
  isDim: (agent: FloorAgent) => boolean;
  onSelect: (slug: string) => void;
  onLink?: (link: FloorLink) => void;
}

interface Point { x: number; y: number }

/** The status a card shows: a finished task reads Completed for a moment. */
function cardLabel(agent: FloorAgent) {
  if (agent.motion === "completed") return "Completed";
  if (agent.status === "working" && agent.motion !== "busy") return MOTION_LABEL[agent.motion];
  return STATUS_LABEL[agent.status];
}

const Card = memo(function Card({ agent, picked, dim, onSelect, register }: {
  agent: FloorAgent; picked: boolean; dim: boolean; onSelect: (slug: string) => void; register: (slug: string, element: HTMLElement | null) => void;
}) {
  const Role = roleIcon(agent.slug);
  const tone = agent.motion === "completed" ? "completed" : agent.status;
  const detail = agent.status === "error" ? null : agent.task ?? (agent.status === "paused" ? "Paused" : agent.status === "idle" ? "Ready for the next task" : "Working");
  return (
    <button type="button" ref={(element) => register(agent.slug, element)} data-agent={agent.slug} data-status={agent.status} data-motion={agent.motion}
      aria-pressed={picked} aria-label={`${agent.name}: ${cardLabel(agent)}${agent.runningTasks > 1 ? `, ${agent.runningTasks} running tasks` : ""}${agent.task ? `. ${agent.task}` : ""}`}
      title={[agent.role, agent.task].filter(Boolean).join("\n") || undefined}
      className={`of-card${agent.seat.big ? " of-card-lead" : ""}${picked ? " of-card-on" : ""}${dim ? " of-dim" : ""}`} onClick={() => onSelect(agent.slug)}>
      <span className="of-card-top">
        <span className="of-card-face"><AgentFigure slug={agent.slug} size={agent.seat.big ? 34 : 28} /></span>
        <span className="of-card-name">{agent.name}</span>
        <Role className="of-card-role" aria-hidden="true" />
      </span>
      <span className={`of-status of-tx-${tone}`}><StatusGlyph status={agent.status} />{cardLabel(agent)}</span>
      {detail && <span className="of-card-task">{agent.motion === "tool" && agent.tool ? `${agent.tool}${agent.target ? ` on ${agent.target}` : ""}` : detail}</span>}
      {agent.status === "error" && <span className="of-card-error">{agent.errorMessage ? "Failed. Select for details." : "Failed"}</span>}
      {agent.status === "approval" && <span className="of-card-approval">Waiting for you</span>}
      {(agent.runningTasks > 0 || agent.queuedTasks > 0) && <span className="of-card-count">{agent.runningTasks} running task{agent.runningTasks === 1 ? "" : "s"}{agent.queuedTasks ? ` · ${agent.queuedTasks} queued` : ""}</span>}
      {agent.status === "working" && <span className="of-card-bar" aria-hidden="true" />}
    </button>
  );
});

/** A gentle S-curve between two cards; vertical bends cross far less than straight lines. */
function curve(a: Point, b: Point) {
  const mid = (a.y + b.y) / 2;
  return `M${a.x} ${a.y} C${a.x} ${mid} ${b.x} ${mid} ${b.x} ${b.y}`;
}

/**
 * Rooms are a responsive grid, so names have room and nothing is cut off.
 * Lines are measured from the cards and only drawn for real relations: active
 * work always, the configured routes only for the selected agent.
 */
export function FloorPlan({ agents, layout, edges, flows = [], selected, isDim, onSelect, onLink }: FloorPlanProps) {
  const host = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [points, setPoints] = useState<Map<string, Point>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const reduced = useReducedMotion();

  const register = useCallback((slug: string, element: HTMLElement | null) => {
    if (element) cards.current.set(slug, element); else cards.current.delete(slug);
  }, []);

  const measure = useCallback(() => {
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    const next = new Map<string, Point>();
    cards.current.forEach((element, slug) => {
      const rect = element.getBoundingClientRect();
      next.set(slug, { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top + rect.height / 2 });
    });
    setPoints(next);
    setSize({ w: box.width, h: box.height });
  }, []);

  // Cards grow and shrink with their text, so a status change can move the line ends too.
  const slugKey = agents.map((agent) => `${agent.slug}:${agent.status}:${agent.motion}:${agent.task ?? ""}`).join(",");
  useLayoutEffect(() => {
    measure();
    if (!host.current) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [measure, slugKey]);

  const narrow = size.w > 0 && size.w < 640;
  const shown = edges.filter((edge) => edge.tone !== "dim" || edge.from === selected || edge.to === selected);
  const flowKey = new Set(flows.map((flow) => `${flow.from}\n${flow.to}`));

  return (
    <div ref={host} className="of-plan" data-floor-canvas="">
      {!narrow && size.w > 0 && (
        <svg className="of-links" width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
          <defs>
            <marker id="of-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 8 4 0 8Z" fill="currentColor" /></marker>
          </defs>
          {shown.map((edge) => {
            const a = points.get(edge.from);
            const b = points.get(edge.to);
            if (!a || !b || flowKey.has(`${edge.from}\n${edge.to}`)) return null;
            const d = curve(a, b);
            return (
              <g key={`${edge.from}-${edge.to}`} data-connection={`${edge.from}-${edge.to}`} data-tone={edge.tone}>
                <path className={`of-link of-link-${edge.tone}${edge.from === selected || edge.to === selected ? " of-link-on" : ""}`} d={d} markerEnd={edge.tone === "dim" ? undefined : "url(#of-arrow)"} />
                {onLink && <path className="of-hit" d={d} onClick={() => onLink({ from: edge.from, to: edge.to, taskId: edge.taskId })}><title>{`${edge.from} to ${edge.to}${edge.taskId ? ": open the task" : ""}`}</title></path>}
              </g>
            );
          })}
          {flows.map((flow) => {
            const a = points.get(flow.from);
            const b = points.get(flow.to);
            if (!a || !b) return null;
            const d = curve(a, b);
            return (
              <g key={`${flow.from}-${flow.to}-${flow.kind}`} data-connection={`${flow.from}-${flow.to}`} data-flow={flow.kind} className={`of-flow of-flow-${flow.kind}`}>
                <path className="of-link of-link-active" d={d} markerEnd="url(#of-arrow)" />
                {!reduced && <circle r="4.5" className="of-packet"><animateMotion dur="1.4s" repeatCount="indefinite" path={d} /></circle>}
                {onLink && <path className="of-hit" d={d} onClick={() => onLink({ from: flow.from, to: flow.to, taskId: flow.taskId })}><title>{flow.kind === "delegate" ? "Work handed over: open the task" : "Results returned: open the task"}</title></path>}
              </g>
            );
          })}
        </svg>
      )}
      <div className="of-rooms">
        {layout.rooms.map((room) => {
          const members = agents.filter((agent) => agent.seat.room === room.id).sort((a, b) => a.seat.y - b.seat.y || a.seat.x - b.seat.x);
          if (!members.length) return null;
          return (
            <section key={room.id} aria-label={room.name} className="of-room" data-room={room.id}>
              <h3>{room.name}<span>{members.filter((agent) => agent.status === "working").length ? `${members.filter((agent) => agent.status === "working").length} working` : ""}</span></h3>
              <div className="of-room-cards">
                {members.map((agent) => <Card key={agent.slug} agent={agent} picked={agent.slug === selected} dim={isDim(agent)} onSelect={onSelect} register={register} />)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
