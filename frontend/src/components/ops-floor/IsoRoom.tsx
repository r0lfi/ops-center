import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Search, ZoomIn, ZoomOut, Maximize2, Activity, GripVertical, RotateCcw } from "lucide-react";
import { STATE_COLOR, type AgentVisual } from "@/lib/opsFloorTypes";

type Point = [number, number];
const WIDTH = 1440;
const HEIGHT = 1000;
const LAYOUT_KEY = "ops-floor-2d-layout-v3";
const pos: Record<string, Point> = { linux:[50,31], monitoring:[27,35], security:[73,35], container:[15,54], patching:[85,54], coordinator:[50,56], network:[27,75], automation:[73,75], chat:[40,90], general:[60,90] };
const defaultPanel: Point = [50, 3];

function readLayout(): { agents: Record<string, Point>; panel: Point } {
  const fallback = { agents: { ...pos }, panel: defaultPanel };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    const valid = (value: unknown): value is Point => Array.isArray(value) && value.length === 2 && value.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100);
    if (stored) {
      for (const slug of Object.keys(pos)) if (valid(stored.agents?.[slug])) fallback.agents[slug] = stored.agents[slug];
      if (valid(stored.panel)) fallback.panel = stored.panel;
    }
  } catch { /* Use a safe default if storage is unavailable or invalid. */ }
  return fallback;
}

// Measure the actual element and scaled canvas so every item can reach its edges.
function dragHandlers(position: Point, onMove: (point: Point) => void, centered: boolean) {
  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0) return;
      const element = event.currentTarget;
      const parent = element.parentElement!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const start: Point = [event.clientX, event.clientY];
      let moved = false;
      element.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent) => {
        if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) < 4 && !moved) return;
        moved = true;
        const halfWidth = bounds.width / parent.width * 50;
        const height = bounds.height / parent.height * 100;
        onMove([
          Math.max(halfWidth + 1, Math.min(99 - halfWidth, position[0] + (e.clientX - start[0]) / parent.width * 100)),
          Math.max((centered ? height / 2 : 0) + 1, Math.min(99 - (centered ? height / 2 : height), position[1] + (e.clientY - start[1]) / parent.height * 100)),
        ]);
      };
      const stopClick = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
      const up = () => {
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", up);
        element.removeEventListener("lostpointercapture", up);
        if (moved) {
          element.addEventListener("click", stopClick, { capture: true, once: true });
          window.setTimeout(() => element.removeEventListener("click", stopClick, true), 0);
        }
      };
      element.addEventListener("pointermove", move);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", up);
      element.addEventListener("lostpointercapture", up);
    },
  };
}

const icons: Record<string,string> = { linux:"🐧", monitoring:"⌁", security:"◉", container:"◈", patching:"↻", network:"⌘", automation:"◇", chat:"◌", general:"▤", coordinator:"✦" };
const tools: Record<string,string[]> = { linux:["RHEL","SSH","systemd"], monitoring:["Prometheus","Grafana"], security:["CVE","Audit"], container:["Docker","K8s"], patching:["Updates","Reboot"], network:["DNS","Firewall"], automation:["Ansible","Jobs"], chat:["Talk","Requests"], general:["Docs","Search"], coordinator:["Routing","Delegation"] };
function AgentCard({ agent, selected, onSelect, position, onMove }: { agent: AgentVisual; selected: boolean; onSelect: () => void; position: [number, number]; onMove: (position: [number, number]) => void }) {
  const color = agent.slug === "coordinator" ? "#00D9FF" : agent.color; const working = agent.state === "working" || agent.state === "investigating"; const coordinator = agent.slug === "coordinator";
  return <button data-agent={agent.slug} onClick={onSelect} {...dragHandlers(position, onMove, true)} className="absolute touch-none select-none cursor-grab text-left active:cursor-grabbing" style={{ left:`${position[0]}%`, top:`${position[1]}%`, width:coordinator?245:220, transform:"translate(-50%,-50%)", zIndex:coordinator?5:3, opacity:selected?1:.96 }}>
    <div className="rounded-lg p-3 shadow-xl transition" style={{ minHeight:coordinator?126:112, background:coordinator?"#0A1724":"#0B121C", border:`${selected?2:1}px solid ${selected?"#00D9FF":working?color:"#1C2D40"}`, boxShadow:coordinator?"0 0 0 8px #00D9FF12, 0 0 0 18px #00D9FF08, 0 0 34px #00D9FF55":working?`0 0 22px ${color}33`:"0 8px 20px #02040955" }}>
      <div className="flex items-center gap-2"><span className="text-xl" style={{color}}>{icons[agent.slug]}</span><span className="font-bold text-[#F3F7FB]">{agent.name}</span><span className="ml-auto flex items-center gap-1 text-[11px]" style={{color:STATE_COLOR[agent.state]}}><i className="h-2 w-2 rounded-full" style={{background:STATE_COLOR[agent.state]}} />{agent.state === "investigating" ? "Thinking" : agent.state[0].toUpperCase()+agent.state.slice(1)}</span></div>
      <div className="mt-2 text-[11px] text-[#C4D0DD]">{agent.activity || "Ready for next task"}</div><div className="mt-1 text-[10px] text-[#8799AD]">{agent.target || (coordinator ? "AI orchestration control" : "No active target")}</div>
      <div className="mt-2 flex gap-1">{(tools[agent.slug] || []).map(t=><span key={t} className="rounded border border-[#284057] bg-[#152235] px-1.5 py-0.5 text-[9px] text-[#BED0E1]">{t}</span>)}</div>

    </div>
  </button>;
}

export function IsoRoom({ agents, onSelect }: { agents: AgentVisual[]; onSelect: (agent: AgentVisual) => void }) {
  const [layout, setLayout] = useState(readLayout);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [zoom, setZoom] = useState(.85);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const positions = layout.agents;
  const point = (agent: AgentVisual): Point => positions[agent.slug] || [agent.home.x, agent.home.y];
  const filtered = useMemo(() => agents.filter(a => {
    const matches = `${a.name} ${a.slug} ${a.activity} ${a.target ?? ""}`.toLowerCase().includes(query.toLowerCase());
    return matches && (filter === "All" || (filter === "Working" ? ["working", "investigating", "walking"].includes(a.state) : filter === "Errors" ? a.state === "error" : a.state === "idle"));
  }), [agents, query, filter]);
  const coordinator = filtered.find(a => a.slug === "coordinator");
  const active = agents.filter(a => ["working", "investigating", "walking"].includes(a.state));
  const save = () => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); setSaveStatus("Saved"); }
    catch { setSaveStatus("Could not save"); }
  };
  const fit = () => {
    if (viewport.current) setZoom(Math.min(1, (viewport.current.clientWidth - 24) / WIDTH));
    viewport.current?.scrollTo({ top: 0, left: 0 });
  };
  return <div className="relative rounded-lg border border-[#1C2D40] bg-[#08111D] pt-14" data-floor-2d>
    <div className="flex flex-wrap items-center gap-2 border-b border-[#1C2D40] px-4 pb-3">
      <label className="flex min-w-40 flex-1 items-center gap-2 rounded-md border border-[#29455F] bg-[#0B121C] px-3 py-2"><Search className="h-4 w-4 text-[#8799AD]"/><input aria-label="Search floor" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search agent, host or task…" className="w-full bg-transparent text-xs text-[#F3F7FB] outline-none"/></label>
      {["All", "Working", "Idle", "Errors"].map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-md border px-2.5 py-2 text-[10px] ${filter === value ? "border-[#00AEE8] bg-[#10273A] text-[#74DCFF]" : "border-[#29455F] text-[#C4D0DD]"}`}>{value}</button>)}
      <button onClick={save} className="rounded-md border border-[#00AEE8] px-2.5 py-2 text-[10px] text-[#74DCFF]">{saveStatus || "Save layout"}</button>
      <button title="Reset layout" aria-label="Reset layout" onClick={() => { setLayout({ agents: { ...pos }, panel: defaultPanel }); setSaveStatus(""); }} className="p-2 text-[#DCE8F5]"><RotateCcw className="h-4 w-4"/></button>
      <button aria-label="Zoom out" onClick={() => setZoom(z => Math.max(.4, z - .1))} className="p-2 text-[#DCE8F5]"><ZoomOut className="h-4 w-4"/></button>
      <span className="w-10 text-center text-[10px] text-[#8799AD]">{Math.round(zoom * 100)}%</span>
      <button aria-label="Zoom in" onClick={() => setZoom(z => Math.min(1.4, z + .1))} className="p-2 text-[#DCE8F5]"><ZoomIn className="h-4 w-4"/></button>
      <button aria-label="Fit map width" onClick={fit} className="p-2 text-[#DCE8F5]"><Maximize2 className="h-4 w-4"/></button>
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-2 text-[10px] text-[#8799AD]"><span>Drag cards and Live Operations to arrange · Scroll to explore</span><span className="text-[#5E91AC]">━ Coordinator connection</span><span className="text-[#20E69A]">━ Active agent</span></div>
    <div ref={viewport} className="h-[760px] max-h-[75vh] min-h-[480px] overflow-auto overscroll-contain" data-floor-viewport>
      <div style={{ width: WIDTH * zoom, height: HEIGHT * zoom }} className="relative mx-auto">
        <div className="absolute left-0 top-0" data-floor-canvas style={{ width: WIDTH, height: HEIGHT, transform: `scale(${zoom})`, transformOrigin: "top left", backgroundImage: "linear-gradient(#14223888 1px,transparent 1px),linear-gradient(90deg,#14223888 1px,transparent 1px)", backgroundSize: "48px 48px" }}>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-label="Coordinator connections">
            {coordinator && filtered.filter(a => a.slug !== "coordinator").map(agent => {
              const [cx, cy] = point(coordinator); const [ax, ay] = point(agent);
              const x1 = cx * WIDTH / 100, y1 = cy * HEIGHT / 100, x2 = ax * WIDTH / 100, y2 = ay * HEIGHT / 100;
              const dx = x2 - x1, dy = y2 - y1, length = Math.max(1, Math.hypot(dx, dy));
              const bend = Math.min(65, length * .18);
              const path = `M ${x1} ${y1} Q ${(x1+x2)/2 - dy/length*bend} ${(y1+y2)/2 + dx/length*bend} ${x2} ${y2}`;
              const working = ["working", "investigating", "walking"].includes(agent.state);
              return <g key={agent.slug} data-connection={agent.slug}><path d={path} fill="none" stroke="#030912" strokeWidth="9"/><path d={path} fill="none" stroke={working ? "#20E69A" : "#48718C"} strokeWidth="3"/><path d={path} fill="none" stroke={working ? "#B2FFE0" : "#8CB2C9"} strokeWidth="1" strokeDasharray="3 8"/></g>;
            })}
          </svg>
          <div data-live-panel {...dragHandlers(layout.panel, panel => { setLayout(v => ({ ...v, panel })); setSaveStatus(""); }, false)} className="absolute z-10 w-[560px] touch-none select-none cursor-grab rounded-lg border border-[#1E3C54] bg-[#08131F] p-4 shadow-lg active:cursor-grabbing" style={{ left: `${layout.panel[0]}%`, top: `${layout.panel[1]}%`, transform: "translateX(-50%)" }}>
            <div className="flex items-center gap-2 text-[#70DFFF]"><GripVertical className="h-4 w-4 text-[#8799AD]"/><Activity className="h-4 w-4"/><b className="text-sm">Ops Center · LIVE OPERATIONS</b><span className="ml-auto rounded bg-[#20E69A22] px-2 py-0.5 text-[9px] text-[#20E69A]">{active.length} ACTIVE</span></div>
            <div className="mt-3 text-sm font-semibold text-[#F3F7FB]">{active.length ? "Current agent activity" : "Ready for next task"}</div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-[10px] text-[#C4D0DD]">{active.slice(0, 3).map(agent => <div key={agent.slug}><span className="text-[#8799AD]">{agent.name}</span><b className="mt-1 block text-[#20E69A]">{agent.activity || agent.state}</b><span className="mt-1 block">{agent.target}</span></div>)}{!active.length && <span className="col-span-3 text-[#8799AD]">Agent activity appears here when work starts.</span>}</div>
          </div>
          {filtered.map(agent => <AgentCard key={agent.slug} agent={agent} position={point(agent)} selected={selected === agent.slug} onSelect={() => { setSelected(agent.slug); onSelect(agent); }} onMove={position => { setLayout(v => ({ ...v, agents: { ...v.agents, [agent.slug]: position } })); setSaveStatus(""); }}/>) }
        </div>
      </div>
    </div>
  </div>;
}
