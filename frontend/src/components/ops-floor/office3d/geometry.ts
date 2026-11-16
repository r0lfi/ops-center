import type { FloorLayout, FloorSeat } from "@/lib/opsFloor/config";

/** A box on the floor. x/y is its north-west corner, z its underside. */
export interface BoxSpec {
  x: number; y: number; z: number; w: number; d: number; h: number;
  top: string; south: string; west: string;
  southClass?: string; westClass?: string; text?: string;
  /** "figure" boxes move together when the agent is animated; the desk stays put. */
  part?: "figure";
}

function shade(hex: string, factor: number) {
  const value = parseInt(hex.slice(1), 16);
  const part = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor))).toString(16).padStart(2, "0");
  return `#${part((value >> 16) & 255)}${part((value >> 8) & 255)}${part(value & 255)}`;
}

interface BoxOptions { top?: string; southClass?: string; westClass?: string; text?: string }

function box(x: number, y: number, z: number, w: number, d: number, h: number, color: string, options: BoxOptions = {}): BoxSpec {
  return { x, y, z, w, d, h, top: options.top ?? shade(color, 1.18), south: color, west: shade(color, 0.68), southClass: options.southClass, westClass: options.westClass, text: options.text };
}

export type Extra = "none" | "headset" | "antenna" | "redhat" | "cap" | "beanie" | "hood" | "wizard";
export interface Look { skin: string; hair: string; shirt: string; face: string; extra: Extra }

/** Our own voxel figures. Unknown agents get the default look. */
const DEFAULT_LOOK: Look = { skin: "#d9a57c", hair: "#475569", shirt: "#334155", face: "of-fc-plain", extra: "none" };
const LOOKS: Record<string, Look> = {
  monitoring: { skin: "#f0c8a0", hair: "#7c3aed", shirt: "#334155", face: "of-fc-glasses", extra: "headset" },
  automation: { skin: "#94a3b8", hair: "#64748b", shirt: "#475569", face: "of-fc-robot", extra: "antenna" },
  linux: { skin: "#e8b88f", hair: "#4a3324", shirt: "#14532d", face: "of-fc-beard", extra: "redhat" },
  network: { skin: "#8d5a3b", hair: "#0f0c0a", shirt: "#0e7490", face: "of-fc-plain", extra: "cap" },
  container: { skin: "#f0c8a0", hair: "#b45309", shirt: "#1e40af", face: "of-fc-glasses", extra: "beanie" },
  security: { skin: "#c99672", hair: "#0a0d12", shirt: "#0b0f14", face: "of-fc-shades", extra: "hood" },
  patching: { skin: "#e8b88f", hair: "#dc2626", shirt: "#57534e", face: "of-fc-plain", extra: "none" },
  chat: { skin: "#8d5a3b", hair: "#ec4899", shirt: "#0f766e", face: "of-fc-plain", extra: "headset" },
  general: { skin: "#f0c8a0", hair: "#e2e8f0", shirt: "#581c87", face: "of-fc-glasses", extra: "wizard" },
  nova: { skin: "#d9a57c", hair: "#15803d", shirt: "#166534", face: "of-fc-plain", extra: "beanie" },
  "ext-coordinator": { skin: "#c99672", hair: "#111827", shirt: "#f1f5f9", face: "of-fc-glasses", extra: "none" },
  "ext-coder": { skin: "#f0c8a0", hair: "#0ea5e9", shirt: "#111827", face: "of-fc-glasses", extra: "hood" },
  "ext-reader": { skin: "#8d5a3b", hair: "#1c1917", shirt: "#7c2d12", face: "of-fc-glasses", extra: "none" },
  "ext-reviewer": { skin: "#e8b88f", hair: "#f59e0b", shirt: "#312e81", face: "of-fc-plain", extra: "cap" },
};

/** The same look the office uses, so a portrait elsewhere matches the figure at the desk. */
export function lookOf(slug: string): Look {
  return LOOKS[slug] ?? DEFAULT_LOOK;
}

function deskProps(slug: string, x: number, y: number, z: number, add: (spec: BoxSpec) => void) {
  const b = (ox: number, oy: number, oz: number, w: number, d: number, h: number, color: string, options?: BoxOptions) => add(box(x + ox, y + oy, z + oz, w, d, h, color, options));
  switch (slug) {
    case "monitoring": b(-36, 6, 0, 16, 3, 13, "#061018", { southClass: "of-graphs" }); break;
    case "automation": b(-34, 3, 0, 10, 10, 5, "#475569"); b(-31, 6, 5, 4, 4, 16, "#94a3b8"); b(-31, 6, 21, 14, 4, 4, "#38bdf8"); break;
    case "network": b(-38, 2, 0, 22, 12, 10, "#0d1218", { southClass: "of-rack" }); break;
    case "container": b(-37, 2, 0, 20, 10, 8, "#dc2626"); b(-36, 3, 8, 18, 9, 8, "#2563eb"); b(-35, 4, 16, 16, 8, 8, "#16a34a"); break;
    case "security": b(-34, 3, 0, 12, 8, 10, "#fbbf24"); b(-31, 5, 10, 6, 4, 5, "#94a3b8"); break;
    case "patching": b(-38, 2, 0, 22, 12, 11, "#b91c1c"); b(-31, 6, 11, 8, 3, 3, "#e5e7eb"); break;
    case "chat": b(-37, 4, 4, 20, 2, 14, "#e6edf3"); b(-28, 4, 0, 3, 2, 4, "#64748b"); break;
    case "general": b(-37, 2, 0, 20, 13, 4, "#9333ea"); b(-36, 3, 4, 18, 12, 4, "#0d9488"); b(-35, 2, 8, 18, 12, 4, "#ea580c"); break;
    case "nova": b(-34, 3, 0, 10, 10, 8, "#92400e"); b(-37, 0, 8, 16, 16, 12, "#16a34a"); break;
    case "ext-coordinator": b(-37, 8, 0, 18, 3, 16, "#f8fafc"); b(-34, 11, 8, 11, 1, 2, "#2563eb"); break;
    case "ext-coder": b(-36, 4, 0, 12, 10, 7, "#facc15"); b(-34, 7, 7, 8, 7, 7, "#fde047"); b(-32, 14, 9, 4, 3, 2, "#ea580c"); break;
    case "ext-reader": b(-37, 3, 0, 22, 13, 2, "#f8fafc"); b(-27, 3, 2, 2, 13, 1, "#7c2d12"); break;
    case "ext-reviewer": b(-34, 2, 0, 14, 14, 3, "#f8fafc"); b(-30, 6, 3, 8, 3, 2, "#dc2626"); break;
    default: break;
  }
}

export function stationBoxes(slug: string, seat: FloorSeat): BoxSpec[] {
  const out: BoxSpec[] = [];
  const add = (spec: BoxSpec) => { out.push(spec); };
  const figure = (spec: BoxSpec) => { out.push({ ...spec, part: "figure" }); };
  const { x, y } = seat;
  const big = !!seat.big;
  const z = big ? 24 : 0;
  const look = LOOKS[slug] ?? DEFAULT_LOOK;
  const screen = "of-screen";

  if (big) {
    add(box(x - 76, y - 62, 0, 152, 104, 24, "#17202b", { top: "#1d2935", southClass: "of-deskfront" }));
    for (const offset of [-74, 30]) {
      add(box(x + offset, y - 56, z, 44, 6, 74, "#18212c"));
      add(box(x + offset + 3, y - 50, z + 30, 38, 1, 34, "#061018", { southClass: screen }));
    }
  }
  // Wall screen behind the figure, then the chair.
  add(box(x - 40, y - 56, z, 80, 6, 94, "#18212c"));
  add(box(x - 36, y - 50, z + 46, 72, 1, 44, "#061018", { southClass: screen }));
  add(box(x - 18, y - 46, z, 36, 6, 58, "#0d1218"));
  add(box(x - 4, y - 36, z, 8, 8, 14, "#0d1218"));
  add(box(x - 18, y - 42, z + 14, 36, 26, 6, "#1a2330"));

  if (slug === "coordinator") {
    // Tux: black body, white belly, orange beak and feet, flippers on the keyboard.
    figure(box(x - 20, y - 16, z, 17, 15, 6, "#f59e0b"));
    figure(box(x + 3, y - 16, z, 17, 15, 6, "#f59e0b"));
    figure(box(x - 21, y - 40, z + 20, 42, 27, 38, "#151a21", { southClass: "of-tuxbelly" }));
    figure(box(x - 28, y - 36, z + 30, 7, 32, 10, "#151a21"));
    figure(box(x + 21, y - 36, z + 30, 7, 32, 10, "#151a21"));
    figure(box(x - 18, y - 39, z + 58, 36, 25, 30, "#151a21", { southClass: "of-tuxface" }));
    figure(box(x - 8, y - 14, z + 62, 16, 9, 7, "#f59e0b", { top: "#fbbf24" }));
  } else {
    figure(box(x - 12, y - 37, z + 20, 24, 28, 7, "#1c2531"));
    figure(box(x - 11, y - 11, z, 22, 7, 22, "#1c2531"));
    figure(box(x - 14, y - 37, z + 22, 28, 17, 28, look.shirt));
    figure(box(x - 21, y - 34, z + 32, 7, 30, 8, look.shirt));
    figure(box(x + 14, y - 34, z + 32, 7, 30, 8, look.shirt));
    figure(box(x - 13, y - 38, z + 50, 26, 22, 24, look.skin, { southClass: look.face }));
    if (look.extra !== "hood" && slug !== "automation") figure(box(x - 14, y - 39, z + 70, 28, 24, 7, look.hair));
    switch (look.extra) {
      case "redhat": figure(box(x - 19, y - 42, z + 76, 38, 32, 3, "#b91c1c")); figure(box(x - 12, y - 36, z + 79, 24, 20, 10, "#dc2626")); break;
      case "headset": figure(box(x - 15, y - 28, z + 58, 3, 8, 11, "#38bdf8")); figure(box(x + 12, y - 28, z + 58, 3, 8, 11, "#38bdf8")); figure(box(x - 14, y - 27, z + 77, 28, 5, 3, "#0d1218")); break;
      case "beanie": figure(box(x - 12, y - 37, z + 77, 24, 20, 7, look.hair)); break;
      case "cap": figure(box(x - 14, y - 17, z + 70, 28, 11, 3, look.hair)); break;
      case "hood": figure(box(x - 16, y - 41, z + 46, 32, 7, 34, look.shirt)); figure(box(x - 15, y - 41, z + 74, 30, 24, 6, look.shirt)); break;
      case "wizard": figure(box(x - 16, y - 40, z + 77, 32, 28, 3, "#3b0764")); figure(box(x - 10, y - 34, z + 80, 20, 16, 9, "#3b0764")); figure(box(x - 5, y - 30, z + 89, 10, 8, 9, "#3b0764")); break;
      case "antenna": figure(box(x - 2, y - 28, z + 74, 4, 4, 11, "#64748b")); figure(box(x - 4, y - 30, z + 85, 8, 8, 5, "#38bdf8")); break;
      default: break;
    }
  }

  // Desk, keyboard, small screen and coffee.
  const half = big ? 58 : 42;
  add(box(x - half, y - 12, z, 6, 36, 22, "#17202b"));
  add(box(x + half - 6, y - 12, z, 6, 36, 22, "#17202b"));
  add(box(x - half, y - 12, z + 22, half * 2, 36, 6, "#2a3644", { top: "#3a4a5c", southClass: "of-deskfront" }));
  add(box(x - 16, y - 7, z + 28, 32, 11, 2, "#0a0e13", { top: "#38bdf8" }));
  add(box(x + half - 12, y - 10, z + 28, 8, 6, 3, "#0d1218"));
  add(box(x + half - 16, y - 10, z + 31, 4, 26, 24, "#0d1218", { westClass: screen }));
  add(box(x + half - 15, y + 15, z + 28, 8, 8, 9, "#d7dfe7"));
  deskProps(slug, x, y, z + 28, add);
  return out;
}

/** Where the figure turns and bobs around: the middle of the person in the chair. */
export function figureOrigin(seat: FloorSeat) {
  return { x: seat.x, y: seat.y - 26, z: seat.big ? 24 : 0 };
}

export function nameplateHeight(seat: FloorSeat) {
  return seat.big ? 122 : 92;
}

/** Everything that never changes: walls, partitions, racks, plants and posters. */
export function officeBoxes(layout: FloorLayout): BoxSpec[] {
  const env: BoxSpec[] = [];
  const east = layout.height + 88;
  env.push(box(-40, -48, 0, 1080, 8, 214, "#121a24", { top: "#1f2a37" }));
  env.push(box(1040, -48, 0, 8, east, 214, "#121a24", { top: "#1f2a37", westClass: "of-windows" }));
  env.push(box(20, -40, 140, 240, 1, 50, "#121a24", { southClass: "of-sign", text: "OPS FLOOR" }));
  env.push(box(760, -40, 118, 100, 1, 74, "#f8fafc", { southClass: "of-poster", text: "SUDO MAKE COFFEE" }));
  env.push(box(885, -40, 118, 100, 1, 74, "#f8fafc", { southClass: "of-poster", text: "THERE IS NO CLOUD" }));
  for (const room of layout.rooms) {
    env.push(box(room.x, room.y, 0, room.w, 3, 12, "#2f3b4a", { top: "#38bdf8" }));
    env.push(box(room.x + room.w - 3, room.y, 0, 3, room.h, 12, "#2f3b4a", { top: "#38bdf8" }));
  }
  // Graph wall in Observe & run, server racks along the north side of Security.
  env.push(box(36, 28, 0, 228, 8, 88, "#18212c"));
  env.push(box(44, 36, 16, 212, 1, 62, "#061018", { southClass: "of-graphs" }));
  for (const x of [734, 790, 846, 902]) env.push(box(x, 26, 0, 50, 24, 92, "#0d1218", { southClass: "of-rack", top: "#26313e" }));
  for (const [x, y] of [[34, 332], [950, 332], [34, 540], [950, 540]]) {
    env.push(box(x, y, 0, 16, 16, 12, "#92400e"));
    env.push(box(x - 5, y - 5, 12, 26, 26, 18, "#15803d"));
    env.push(box(x, y, 30, 16, 16, 12, "#16a34a"));
  }
  return env;
}

export const BOARD_BOX = box(290, -40, 126, 420, 1, 76, "#061018", { southClass: "of-noc" });
