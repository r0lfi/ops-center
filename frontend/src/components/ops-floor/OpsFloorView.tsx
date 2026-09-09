import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Crosshair, Maximize, Minimize, Pause, Play, RefreshCw, Repeat, RotateCcw, RotateCw, ZoomIn, ZoomOut, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentVisual } from "@/lib/opsFloorTypes";

import { IsoRoom } from "./IsoRoom";
import type { CameraCommand } from "./three/OpsFloorScene";

// The Three.js scene (and three itself) only loads when the 3D view is
// actually shown - the rest of the dashboard stays light.
const OpsFloorScene = lazy(() => import("./three/OpsFloorScene").then((m) => ({ default: m.OpsFloorScene })));

const VIEW_KEY = "ops_floor_view";
type View = "3d" | "2d";

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function initialView(): View {
  if (!webglAvailable()) return "2d";
  try {
    return localStorage.getItem(VIEW_KEY) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

/** If the WebGL scene throws (lost context, driver quirk), fall back to
 * the 2D room instead of taking the page down. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface OpsFloorViewProps {
  agents: AgentVisual[];
  onSelect: (agent: AgentVisual) => void;
  /** "full" gives the standalone Ops Floor page a taller canvas and the
   * complete camera-control toolbar (rotate/reset/fullscreen/auto-rotate/
   * focus); "embedded" (default) keeps the compact card used elsewhere
   * (e.g. the AI dashboard) exactly as before. */
  variant?: "embedded" | "full";
  /** Which agent is currently selected elsewhere on the page - enables the
   * "focus selected" camera button. Full variant only. */
  selectedSlug?: string | null;
}

/**
 * The Ops Floor panel: the Three.js diorama as the primary view, the SVG
 * isometric room as "2D View"/fallback, with the same 2D/3D + zoom
 * controls the reference design shows in the panel header.
 */
export function OpsFloorView({ agents, onSelect, variant = "embedded", selectedSlug = null }: OpsFloorViewProps) {
  const [view, setView] = useState<View>(initialView);
  const [zoom, setZoom] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null);
  const [demoStep, setDemoStep] = useState<number | null>(null);
  const [demoPaused, setDemoPaused] = useState(false);
  const [demoSpeed, setDemoSpeed] = useState<"slow" | "normal" | "fast">("normal");
  const containerRef = useRef<HTMLDivElement>(null);
  const full = variant === "full";
  const demoAgents = demoStep === null ? agents : agents.map((agent, index) => {
    const active = index <= demoStep % Math.max(agents.length, 1);
    return { ...agent, state: (active ? (index % 3 === 0 ? "investigating" : "working") : "waiting") as AgentVisual["state"], activity: active ? "Demo run: processing coordinated task" : "Demo queued for handoff" };
  });

  useEffect(() => {
    if (demoStep === null || demoPaused) return;
    const timer = window.setTimeout(() => setDemoStep((step) => step === null ? null : (step + 1) % (Math.max(agents.length, 1) + 8)), demoSpeed === "slow" ? 1800 : demoSpeed === "fast" ? 650 : 1100);
    return () => window.clearTimeout(timer);
  }, [demoStep, agents.length]);

  function choose(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* private mode etc. - the toggle still works for this page load */
    }
  }

  function dispatch(command: Omit<CameraCommand, "token">) {
    if (command.type === "reset" || command.type === "focus") setZoom(1);
    setCameraCommand({ ...command, token: Date.now() + Math.random() });
  }

  // ESC returns to the overview camera; only wired for the full page (the
  // embedded dashboard card shouldn't steal Escape from the rest of the page).
  useEffect(() => {
    if (!full || view !== "3d") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dispatch({ type: "reset" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, view]);

  useEffect(() => {
    function onChange() {
      setFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen?.().catch(() => {});
    }
  }

  if (view === "2d") {
    return (
      <div className="relative">
        <div className="absolute left-3 top-3 z-30">
          <ViewToggle view={view} onChange={choose} />
        </div>
        <IsoRoom agents={agents} onSelect={onSelect} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn("relative overflow-hidden bg-[#04070C]", full && "h-full")} style={{ border: "1px solid #1C2D40", borderRadius: 8 }}>
      <div className="absolute left-3 top-3 z-30">
        <ViewToggle view={view} onChange={choose} />
      </div>
      {demoStep !== null && <div className="absolute left-28 top-3 z-30 rounded-md border border-[#00B8E6] bg-[#062536]/95 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-[#74DCFF]">DEMO MODE · {demoPaused ? "PAUSED" : "LIVE"}</div>}
      <div className="absolute right-3 top-3 z-30 flex flex-wrap justify-end gap-1">
        {full && (
          <>
            <ToolButton title="Reset camera" onClick={() => dispatch({ type: "reset" })}><RefreshCw className="h-4 w-4" /></ToolButton>
            <ToolButton title={demoStep === null ? "Start visual agent demo" : demoPaused ? "Resume visual agent demo" : "Pause visual agent demo"} active={demoStep !== null && !demoPaused} onClick={() => { if (demoStep === null) { setDemoStep(0); setDemoPaused(false); } else { setDemoPaused((value) => !value); } }}>{demoStep !== null && !demoPaused ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</ToolButton>
            <ToolButton title="Reset demo" disabled={demoStep === null} onClick={() => { setDemoStep(0); setDemoPaused(false); }}><RefreshCw className="h-4 w-4" /></ToolButton>
            <ToolButton title="Settings" active={settingsOpen} onClick={() => setSettingsOpen(v => !v)}><Settings className="h-4 w-4" /></ToolButton>
            {settingsOpen && <div className="absolute right-0 top-11 flex gap-1 rounded-lg border border-[#29455F] bg-[#0B121C] p-2">
            <ToolButton title="Rotate left" onClick={() => dispatch({ type: "rotate", dir: -1 })}>
              <RotateCcw className="h-4 w-4" />
            </ToolButton>
            <ToolButton title="Rotate right" onClick={() => dispatch({ type: "rotate", dir: 1 })}>
              <RotateCw className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              title="Focus selected agent"
              disabled={!selectedSlug}
              onClick={() => selectedSlug && dispatch({ type: "focus", slug: selectedSlug })}
            >
              <Crosshair className="h-4 w-4" />
            </ToolButton>
            <ToolButton title={autoRotate ? "Stop auto-rotate" : "Auto rotate"} active={autoRotate} onClick={() => setAutoRotate((v) => !v)}>
              <Repeat className="h-4 w-4" />
            </ToolButton>
            <select aria-label="Demo speed" value={demoSpeed} onChange={(event) => setDemoSpeed(event.target.value as typeof demoSpeed)} className="h-8 rounded-md border border-[#29455F] bg-[#111B29] px-2 text-[11px] text-[#C4D0DD]">
              <option value="slow">Demo slow</option>
              <option value="normal">Demo normal</option>
              <option value="fast">Demo fast</option>
            </select>
            </div>}
            <ToolButton title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </ToolButton>
          </>
        )}
        <ToolButton title="Zoom out" onClick={() => setZoom((z) => Math.max(0.7, z - 0.15))}>
          <ZoomOut className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="Zoom in" onClick={() => setZoom((z) => Math.min(2, z + 0.15))}>
          <ZoomIn className="h-4 w-4" />
        </ToolButton>
      </div>
      {/* explicit height (not only aspect-ratio) - the canvas sizes itself
          from this box, and a percentage-height child of a min-height-only
          parent collapses (learned the hard way on the 2D view) */}
      <div className={cn("relative w-full", full ? "h-full min-h-0" : "h-[360px] sm:h-auto sm:aspect-[16/10]")}>
        <SceneBoundary onError={() => choose("2d")}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading Ops Floor…</div>}>
            <OpsFloorScene
              agents={demoAgents}
              onSelect={onSelect}
              onFocus={(slug) => dispatch({ type: "focus", slug })}
              zoom={zoom}
              autoRotate={autoRotate}
              cameraCommand={cameraCommand}
              selectedSlug={selectedSlug}
            />
          </Suspense>
        </SceneBoundary>
      </div>
    </div>
  );
}

function ToolButton({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center justify-center rounded-md transition-colors disabled:opacity-40"
      style={{
        width: 34,
        height: 34,
        background: active ? "#00AEE8" : hover ? "#142334" : "rgba(8,15,24,0.88)",
        border: `1px solid ${active ? "#20DFFF" : hover ? "#00B8E6" : "#24384D"}`,
        color: active ? "#ffffff" : "#DCE8F5",
      }}
    >
      {children}
    </button>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="flex gap-0.5 p-0.5" style={{ background: "#0B121C", border: "1px solid #1C2D40", borderRadius: 7 }}>
      {(["2d", "3d"] as const).map((v) => {
        const isActive = view === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className="rounded-md font-semibold transition-colors"
            style={{
              height: 32,
              padding: "0 10px",
              fontSize: 12,
              background: isActive ? "#00AEE8" : "#111B29",
              border: `1px solid ${isActive ? "#20DFFF" : "#23364A"}`,
              color: isActive ? "#FFFFFF" : "#A9B8C7",
            }}
          >
            {v === "2d" ? "2D View" : "3D View"}
          </button>
        );
      })}
    </div>
  );
}
