export type AgentVisualState =
  | "idle"
  | "walking"
  | "working"
  | "investigating"
  | "waiting"
  | "success"
  | "error";

export interface StationDefinition {
  slug: string;
  label: string;
  /** Grid coordinates, 0-100, shared by every Ops Floor renderer. */
  x: number;
  y: number;
  color: string;
  /** No backend agent exists for this slug yet - shown inert/dimmed. */
  placeholder?: boolean;
}

export interface AgentVisual {
  slug: string;
  offline?: boolean;
  taskId?: string | null;
  name: string;
  color: string;
  home: { x: number; y: number };
  position: { x: number; y: number };
  state: AgentVisualState;
  activity: string;
  target: string | null;
}

// Single source of truth for the whole floor plan - real agents and
// not-yet-built ones alike, so every renderer (Ops Floor, event wiring,
// War Room gathering) agrees on where things are. x/y are direct screen
// percentages within the floor panel (hand-placed to match the reference
// layout's arrangement), not a projected grid - reliable to hand-tune
// without being able to render and look at intermediate math.
// Coordinator sits at the physical center (the hologram table); everyone
// else arranges around it.
// Colours are each agent's "Accent" from the design contract's §AGENT
// COLORS palette - used here for the 2D view, badges and activity dots;
// the 3D scene's fuller primary/secondary/accent robot theme and the
// (sometimes slightly different) floor-zone neon colour live in
// three/layout.ts's ROBOT_THEME/ZONE_COLOR, which is the source of truth
// for the 3D room specifically.
export const STATIONS: StationDefinition[] = [
  { slug: "monitoring", label: "Monitoring", x: 22, y: 26, color: "#4DB2FF" },
  { slug: "linux", label: "Linux Ops", x: 47, y: 18, color: "#00D9FF" },
  { slug: "security", label: "Security", x: 72, y: 26, color: "#FF4D67" },
  { slug: "container", label: "Containers", x: 16, y: 54, color: "#22E6A3" },
  { slug: "coordinator", label: "Coordinator", x: 48, y: 56, color: "#00D9FF" },
  { slug: "patching", label: "Patching", x: 80, y: 54, color: "#FFC247" },
  { slug: "network", label: "Network", x: 24, y: 82, color: "#47E5FF" },
  { slug: "automation", label: "Automation", x: 72, y: 82, color: "#A873FF" },
  // Pushed further from the coordinator's y than a straight midpoint would
  // put it - its own label sits close enough to the platform's rings
  // otherwise (see IsoRoom.tsx's Desk label positioning).
  { slug: "general", label: "General", x: 48, y: 96, color: "#FF7A1A" },
  // Tucked into the gap between the side rack and Network's zone - the
  // main grid (3x3 around the coordinator) is fully packed, this is the
  // only clear pocket of floor left for a 10th desk.
  { slug: "chat", label: "Chat", x: 2, y: 67, color: "#F05CFF" },
];

export const REAL_AGENT_SLUGS = STATIONS.filter((s) => !s.placeholder).map((s) => s.slug);

export function stationBySlug(slug: string): StationDefinition | undefined {
  return STATIONS.find((s) => s.slug === slug);
}

// Exact values from the design contract's §STATUS COLORS.
export const STATE_COLOR: Record<AgentVisualState, string> = {
  idle: "#268CFF",
  walking: "#268CFF",
  working: "#20E69A",
  investigating: "#00D9FF",
  waiting: "#FFC247",
  success: "#20E69A",
  error: "#FF4D67",
};

export const STATE_LABEL: Record<AgentVisualState, string> = {
  idle: "Idle",
  walking: "Walking",
  working: "Working",
  investigating: "Investigating",
  waiting: "Waiting",
  success: "Success",
  error: "Error",
};
