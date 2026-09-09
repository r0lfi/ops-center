// World units are literal metres, matching the design contract's exact
// room/camera/agent coordinates - not a projected percentage grid like the
// 2D view (opsFloorTypes.STATIONS x/y) uses. Keeping these separate is
// deliberate: the 2D SVG room has its own independent layout, the 3D scene
// now reproduces the contract's numbers as directly as possible.
export const ROOM_W = 18;
export const ROOM_D = 13;
export const ROOM_H = 5;

export const CAMERA_START = { position: [0, 11.0, 18.7] as [number, number, number], target: [0, 1.0, 0] as [number, number, number], fov: 35 };

/** Percentage (0-100, the 2D view's coordinate space) to 3D world metres -
 * only used for the transient "gathering near the coordinator" animation
 * target (opsFloorEvents.ts's GATHER_SLOTS are shared with the 2D view, so
 * they stay percentage-based); every station's actual desk position below
 * uses the contract's literal metre coordinates directly instead. */
export function toWorld(xPct: number, yPct: number): [number, number] {
  return [((xPct - 50) / 100) * ROOM_W, ((yPct - 50) / 100) * ROOM_D];
}

// Agent floor layout - exact x/z from the design contract. z<0 is the back
// wall (server racks, Ops Center sign), z>0 is toward the camera.
export const STATION_WORLD: Record<string, [number, number]> = {
  coordinator: [0, 0],
  linux: [0, -4.5],
  monitoring: [-4.4, -3.5],
  security: [4.4, -3.5],
  container: [-6.0, -0.8],
  patching: [6.0, -0.8],
  network: [-3.3, 3.1],
  automation: [4.5, 3.0],
  chat: [-6.6, 3.6],
  general: [0, 4.5],
};

export const POSE_BY_SLUG: Record<string, "stand" | "type" | "point" | "lean"> = {
  monitoring: "type",
  linux: "stand",
  security: "point",
  container: "lean",
  coordinator: "point",
  patching: "type",
  network: "lean",
  automation: "point",
  general: "stand",
  chat: "lean",
};

/** Floor-zone neon border colour per agent (design contract §WORKSTATION FLOOR ZONES). */
export const ZONE_COLOR: Record<string, string> = {
  linux: "#00D9FF",
  monitoring: "#268CFF",
  container: "#16C784",
  network: "#16C7E8",
  chat: "#F05CFF",
  security: "#FF4D67",
  patching: "#FFC247",
  automation: "#8B5CF6",
  general: "#FF7A1A",
  coordinator: "#00D9FF",
};

export interface RobotTheme {
  primary: string;
  secondary: string;
  accent: string;
}

/** Robot shell colour theme per agent (design contract §AGENT COLORS). */
export const ROBOT_THEME: Record<string, RobotTheme> = {
  linux: { primary: "#D5E1EA", secondary: "#627485", accent: "#00D9FF" },
  monitoring: { primary: "#2869D8", secondary: "#15478F", accent: "#4DB2FF" },
  container: { primary: "#15966E", secondary: "#0E654D", accent: "#22E6A3" },
  network: { primary: "#16A4C4", secondary: "#0D6E87", accent: "#47E5FF" },
  chat: { primary: "#C740CC", secondary: "#76247A", accent: "#F05CFF" },
  security: { primary: "#D94352", secondary: "#862532", accent: "#FF4D67" },
  patching: { primary: "#D99A12", secondary: "#8C6106", accent: "#FFC247" },
  automation: { primary: "#7651D8", secondary: "#49318F", accent: "#A873FF" },
  general: { primary: "#C55720", secondary: "#783419", accent: "#FF7A1A" },
  coordinator: { primary: "#CED9E2", secondary: "#405363", accent: "#00D9FF" },
};
