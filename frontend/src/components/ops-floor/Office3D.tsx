import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Minus, Plus, RotateCcw, RotateCw, Undo2 } from "lucide-react";

import type { FloorLayout, FloorSeat } from "@/lib/opsFloor/config";
import { MOTION_LABEL, screenKind, STATUS_LABEL, type FloorAgent, type FloorEdge, type FloorFlow, type FloorStatus, type Motion } from "@/lib/opsFloor/model";

import { BOARD_BOX, figureOrigin, nameplateHeight, officeBoxes, stationBoxes, type BoxSpec } from "./office3d/geometry";
import "./office3d/office3d.css";
import { StatusGlyph } from "./StatusGlyph";
import { useReducedMotion } from "./useReducedMotion";

interface Camera { yaw: number; tilt: number; zoom: number; panX: number; panY: number; preset: string | null }

const PRESETS: Record<string, Camera> = {
  Overview: { yaw: -32, tilt: 54, zoom: 0.84, panX: 0, panY: 0, preset: "Overview" },
  Top: { yaw: -6, tilt: 12, zoom: 0.92, panX: 0, panY: 0, preset: "Top" },
  "Low angle": { yaw: -52, tilt: 66, zoom: 1.02, panX: 0, panY: 0, preset: "Low angle" },
};
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const limit = (camera: Camera): Camera => ({
  ...camera, yaw: clamp(camera.yaw, -78, -6), tilt: clamp(camera.tilt, 10, 72), zoom: clamp(camera.zoom, 0.5, 2.2),
  panX: clamp(camera.panX, -520, 520), panY: clamp(camera.panY, -420, 420),
});

const DRAG_THRESHOLD_PX = 4;
const YAW_PER_PX = 0.25;
const TILT_PER_PX = 0.2;
const WORLD_FIT_PX = 1060;
const FOCUS_ZOOM = 1.45;

function worldTransform(camera: Camera, fit: number) {
  return `scale(${fit * camera.zoom}) rotateX(${camera.tilt}deg) rotateZ(${camera.yaw}deg) translate(${-camera.panX}px, ${-camera.panY}px)`;
}

/** Signs face the camera and shrink more slowly than the room, so they stay legible on a phone. */
function signTransform(element: HTMLElement, camera: Camera, fit: number) {
  const { x, y, z } = element.dataset;
  const grow = Math.min(1.9, 1 / Math.sqrt(fit * camera.zoom));
  return `translate3d(${x}px,${y}px,${z}px) rotateZ(${-camera.yaw}deg) rotateX(${-camera.tilt}deg) translate(-50%,-100%) scale(${grow})`;
}

// A sliver this small is not visible at any allowed camera angle, and each face costs a layer.
const showsWest = (spec: BoxSpec) => !!spec.westClass || (spec.d > 6 && spec.h > 3);
const showsSouth = (spec: BoxSpec) => !!spec.southClass || !!spec.text || spec.h > 2;

const Box = memo(function Box({ spec }: { spec: BoxSpec }) {
  const { x, y, z, w, d, h } = spec;
  return (
    <div className="of-cb" style={{ transform: `translate3d(${x}px,${y}px,${z}px)` }}>
      <div className="of-f" style={{ width: w, height: d, backgroundColor: spec.top, transform: `translateZ(${h}px)` }} />
      {showsWest(spec) && <div className={`of-f ${spec.westClass ?? ""}`} style={{ left: 0, top: -h, width: d, height: h, backgroundColor: spec.west, transformOrigin: "0 100%", transform: "rotateZ(90deg) rotateX(-90deg)" }} />}
      {showsSouth(spec) && <div className={`of-f ${spec.southClass ?? ""}`} style={{ left: 0, top: d - h, width: w, height: h, backgroundColor: spec.south, transformOrigin: "50% 100%", transform: "rotateX(-90deg)" }}>{spec.text}</div>}
    </div>
  );
});

const Boxes = memo(function Boxes({ boxes }: { boxes: BoxSpec[] }) {
  return <>{boxes.map((spec, index) => <Box key={index} spec={spec} />)}</>;
});

interface StationProps {
  slug: string; seat: FloorSeat; desk: BoxSpec[]; figure: BoxSpec[]; status: FloorStatus; motion: Motion;
  /** Degrees the figure turns to face the agent it is handing work to. */
  face: number; dim: boolean; picked: boolean; onPick: (slug: string) => void; onFocus: (slug: string) => void;
}

/**
 * Status, motion and dimming are attributes here, so a change touches one
 * element and CSS does the animation; the boxes are never rebuilt.
 */
const Station = memo(function Station({ slug, seat, desk, figure, status, motion, face, dim, picked, onPick, onFocus }: StationProps) {
  const m = seat.big ? 86 : 50;
  const top = seat.big ? 72 : 64;
  const ring = { left: seat.x - m, top: seat.y - top, width: m * 2, height: top + (seat.big ? 52 : 36), transform: `translateZ(${seat.big ? 26 : 2}px)` };
  const origin = figureOrigin(seat);
  return (
    <div className="of-station" data-station={slug} data-status={status} data-motion={motion} data-screen={screenKind(slug)}
      data-dim={dim ? "" : undefined} onClick={() => onPick(slug)} onDoubleClick={() => onFocus(slug)}>
      {picked && <div className="of-ring" style={ring} />}
      {(status === "approval" || status === "error") && <div className={`of-ring of-ring-${status}`} style={ring} />}
      {(motion === "starting" || motion === "completed") && <div key={motion} className={`of-ring of-ring-${motion}`} style={ring} />}
      <Boxes boxes={desk} />
      <div className="of-fig" style={{ transformOrigin: `${origin.x}px ${origin.y}px`, ["--of-face" as string]: `${face}deg` }}>
        <Boxes boxes={figure} />
      </div>
    </div>
  );
});

interface Office3DProps {
  agents: FloorAgent[];
  layout: FloorLayout;
  edges: FloorEdge[];
  flows: FloorFlow[];
  selected: string | null;
  isDim: (agent: FloorAgent) => boolean;
  onSelect: (slug: string) => void;
  needs: number;
  working: number;
}

const FOLLOW_KEY = "ops_floor_follow";
const AUTOFOCUS_KEY = "ops_floor_autofocus";
const readFlag = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const writeFlag = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* Lasts this visit. */ } };

export function Office3D({ agents, layout, edges, flows, selected, isDim, onSelect, needs, working }: Office3DProps) {
  const [camera, setCamera] = useState<Camera>(PRESETS.Overview);
  const [fit, setFit] = useState(0);
  const [follow, setFollow] = useState(() => readFlag(FOLLOW_KEY));
  const [autoFocus, setAutoFocus] = useState(() => readFlag(AUTOFOCUS_KEY));
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const signs = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const live = useRef(camera);
  live.current = camera;

  const slugKey = agents.map((agent) => agent.slug).join(",");
  // Built once for each set of agents. Live updates reuse these arrays.
  const geometry = useMemo(() => new Map(agents.map((agent) => {
    const boxes = stationBoxes(agent.slug, agent.seat);
    return [agent.slug, { desk: boxes.filter((box) => box.part !== "figure"), figure: boxes.filter((box) => box.part === "figure") }];
  })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [slugKey]);
  const room = useMemo(() => officeBoxes(layout), [layout.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const seatOf = useMemo(() => new Map(agents.map((agent) => [agent.slug, agent.seat])), [agents]);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setFit(Math.min(1.25, entry.contentRect.width / WORLD_FIT_PX)));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);

  const paint = useCallback((next: Camera) => {
    if (world.current && fit) world.current.style.transform = worldTransform(next, fit);
    signs.current?.querySelectorAll<HTMLElement>("[data-sign]").forEach((element) => { element.style.transform = signTransform(element, next, fit || 1); });
  }, [fit]);

  useLayoutEffect(() => { paint(camera); }, [camera, paint, slugKey]);

  const focusOn = useCallback((slug: string) => {
    const seat = seatOf.get(slug);
    if (!seat) return;
    setCamera((current) => limit({ ...current, zoom: Math.max(current.zoom, FOCUS_ZOOM), panX: seat.x - 500, panY: seat.y - layout.height / 2, preset: null }));
  }, [seatOf, layout.height]);

  const pick = useCallback((slug: string) => { onSelect(slug); }, [onSelect]);
  const focus = useCallback((slug: string) => { onSelect(slug); focusOn(slug); }, [onSelect, focusOn]);

  // Following keeps the camera on whoever is selected.
  useEffect(() => { if (follow && selected) focusOn(selected); }, [follow, selected, focusOn]);

  // Optionally jump to an agent the moment it starts waiting for the user.
  const waiting = agents.filter((agent) => agent.status === "approval").map((agent) => agent.slug).join(",");
  const seenWaiting = useRef(waiting);
  useEffect(() => {
    const before = new Set(seenWaiting.current.split(",").filter(Boolean));
    seenWaiting.current = waiting;
    if (!autoFocus) return;
    const fresh = waiting.split(",").find((slug) => slug && !before.has(slug));
    if (fresh) focus(fresh);
  }, [waiting, autoFocus, focus]);

  // Wheel zooms the office instead of scrolling the page. Passive listeners cannot prevent that, so it is attached by hand.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setCamera((current) => limit({ ...current, zoom: current.zoom * (event.deltaY > 0 ? 0.92 : 1.08), preset: null }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  function onPointerDown(event: React.PointerEvent) {
    if ((event.target as HTMLElement).closest("[data-camera-controls]")) return;
    // Left drag turns the camera. Right drag, middle drag or Shift+drag moves it.
    const pan = event.button === 2 || event.button === 1 || event.shiftKey;
    if (event.button !== 0 && !pan) return;
    const start = { x: event.clientX, y: event.clientY, camera: live.current };
    let latest = start.camera;
    let frame = 0;
    dragged.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!dragged.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!dragged.current) { dragged.current = true; world.current?.classList.add("of-dragging"); }
      if (pan) {
        // Screen movement into floor movement: undo the turn and the tilt, then the zoom.
        const scale = (fit || 1) * start.camera.zoom;
        const angle = (-start.camera.yaw * Math.PI) / 180;
        const sy = dy / Math.max(0.3, Math.cos((start.camera.tilt * Math.PI) / 180));
        latest = limit({ ...start.camera, panX: start.camera.panX - (dx * Math.cos(angle) - sy * Math.sin(angle)) / scale, panY: start.camera.panY - (dx * Math.sin(angle) + sy * Math.cos(angle)) / scale, preset: null });
      } else {
        latest = limit({ ...start.camera, yaw: start.camera.yaw + dx * YAW_PER_PX, tilt: start.camera.tilt - dy * TILT_PER_PX, preset: null });
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(latest); });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) cancelAnimationFrame(frame);
      if (dragged.current) { world.current?.classList.remove("of-dragging"); setCamera(latest); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // A drag ends with a click on whatever is under the pointer. That one must not select.
  function onClickCapture(event: React.MouseEvent) {
    if (!dragged.current) return;
    dragged.current = false;
    event.stopPropagation();
    event.preventDefault();
  }

  const nudge = (change: Partial<Camera>) => setCamera((current) => limit({ ...current, yaw: current.yaw + (change.yaw ?? 0), zoom: current.zoom + (change.zoom ?? 0), preset: null }));
  const faceOf = (agent: FloorAgent) => {
    const from = agent.seat;
    const to = agent.peer ? seatOf.get(agent.peer) : undefined;
    if (!to || agent.motion !== "delegating") return 0;
    // The figure looks south (towards +y) by default.
    return Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI - 90);
  };
  const load = needs > 0 ? "alert" : working > 0 ? "busy" : "calm";

  return (
    <div ref={stage} className="of-stage" role="group" aria-label="3D office. Every agent has a labelled button." onPointerDown={onPointerDown} onClickCapture={onClickCapture} onContextMenu={(event) => event.preventDefault()}>
      <div ref={world} className="of-world" data-load={load} style={{ height: layout.height, marginTop: -layout.height / 2 }}>
        <div className="of-ground" aria-hidden="true" />
        {layout.rooms.map((item) => <div key={item.id} className="of-room3" aria-hidden="true" style={{ left: item.x, top: item.y, width: item.w, height: item.h }}>{item.name}</div>)}
        <svg className="of-cables" style={{ height: layout.height }} viewBox={`0 0 1000 ${layout.height}`} aria-hidden="true">
          {edges.map((edge) => {
            const from = seatOf.get(edge.from);
            const to = seatOf.get(edge.to);
            if (!from || !to) return null;
            return <path key={`${edge.from}-${edge.to}`} data-cable={`${edge.from}-${edge.to}`} className={`of-link of-link-${edge.tone}${edge.from === selected || edge.to === selected ? " of-link-on" : ""}`} d={`M${from.x} ${from.y} L${to.x} ${to.y}`} />;
          })}
          {flows.map((flow) => {
            const from = seatOf.get(flow.from);
            const to = seatOf.get(flow.to);
            if (!from || !to) return null;
            const d = `M${from.x} ${from.y} L${to.x} ${to.y}`;
            return (
              <g key={`${flow.from}-${flow.to}-${flow.kind}`} data-flow={`${flow.from}-${flow.to}`} className={`of-flow of-flow-${flow.kind}`}>
                <path className="of-link of-link-active" d={d} />
                {!reduced && <rect x={-7} y={-5} width={14} height={10} rx={2} className="of-packet"><animateMotion dur="1.6s" repeatCount="indefinite" path={d} /></rect>}
              </g>
            );
          })}
        </svg>
        <div aria-hidden="true" className="of-pass"><Boxes boxes={room} /><Box spec={{ ...BOARD_BOX, text: `NEEDS YOU ${needs} / WORKING ${working}` }} /></div>
        {agents.map((agent) => {
          const parts = geometry.get(agent.slug);
          return <Station key={agent.slug} slug={agent.slug} seat={agent.seat} desk={parts?.desk ?? []} figure={parts?.figure ?? []} status={agent.status} motion={agent.motion}
            face={faceOf(agent)} dim={isDim(agent)} picked={agent.slug === selected} onPick={pick} onFocus={focus} />;
        })}
        <div ref={signs} className="of-pass">
          {agents.map((agent) => (
            <div key={agent.slug} className="of-sign3" data-sign="" data-x={agent.seat.x} data-y={agent.seat.y - 26} data-z={nameplateHeight(agent.seat)}>
              {agent.status === "approval" && <span className="of-bubble of-bubble-approval" aria-hidden="true">?</span>}
              {agent.status === "error" && <span className="of-bubble of-bubble-error" aria-hidden="true">!</span>}
              {agent.status === "working" && agent.motion !== "busy" && <span className="of-bubble3 of-bubble-talk" aria-hidden="true">{agent.motion === "tool" && agent.tool ? agent.tool : MOTION_LABEL[agent.motion]}</span>}
              {agent.motion === "completed" && <span className="of-bubble3 of-bubble-done" aria-hidden="true">Done</span>}
              <button type="button" data-agent={agent.slug} data-status={agent.status} aria-pressed={agent.slug === selected} className={`of-plate${agent.slug === selected ? " of-plate-on" : ""}`}
                aria-label={`${agent.name}: ${STATUS_LABEL[agent.status]}${agent.task ? `. ${agent.task}` : ""}`} onClick={() => pick(agent.slug)} onDoubleClick={() => focus(agent.slug)}>
                <StatusGlyph status={agent.status} size={10} />{agent.short}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="of-cam of-cam-presets" data-camera-controls="">
        <div className="of-seg" role="group" aria-label="Camera">
          {Object.values(PRESETS).map((preset) => <button key={preset.preset} type="button" aria-pressed={camera.preset === preset.preset} onClick={() => setCamera(preset)}>{preset.preset}</button>)}
        </div>
        <div className="of-seg" role="group" aria-label="Camera follows">
          <button type="button" aria-pressed={follow} title="Keep the camera on the selected agent" onClick={() => { setFollow(!follow); writeFlag(FOLLOW_KEY, !follow); }}>Follow selected</button>
          <button type="button" aria-pressed={autoFocus} title="Move the camera to an agent when it starts waiting for you" onClick={() => { setAutoFocus(!autoFocus); writeFlag(AUTOFOCUS_KEY, !autoFocus); }}>Focus approvals</button>
        </div>
      </div>
      <div className="of-cam of-cam-move" data-camera-controls="">
        <button type="button" className="of-iconbtn" aria-label="Focus the selected agent" title="Focus the selected agent (or double-click it)" disabled={!selected} onClick={() => selected && focusOn(selected)}><Crosshair className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="of-iconbtn" aria-label="Reset camera" title="Reset camera" onClick={() => setCamera(PRESETS.Overview)}><Undo2 className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="of-iconbtn" aria-label="Rotate left" onClick={() => nudge({ yaw: -15 })}><RotateCcw className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="of-iconbtn" aria-label="Rotate right" onClick={() => nudge({ yaw: 15 })}><RotateCw className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="of-iconbtn" aria-label="Zoom out" onClick={() => nudge({ zoom: -0.1 })}><Minus className="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" className="of-iconbtn" aria-label="Zoom in" onClick={() => nudge({ zoom: 0.1 })}><Plus className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
  );
}
