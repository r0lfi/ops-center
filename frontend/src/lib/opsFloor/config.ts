/** Where everyone sits. The one place to move an agent to another room or seat. */

export const WORLD_WIDTH = 1000;
export const WORLD_HEIGHT = 600;

export interface FloorRoom { id: string; name: string; x: number; y: number; w: number; h: number }
export interface FloorSeat { room: string; x: number; y: number; short?: string; big?: boolean }

export const ROOMS: FloorRoom[] = [
  { id: "observe", name: "Observe & run", x: 20, y: 20, w: 260, h: 350 },
  { id: "infrastructure", name: "Infrastructure", x: 300, y: 20, w: 400, h: 170 },
  { id: "security", name: "Security", x: 720, y: 20, w: 260, h: 350 },
  { id: "core", name: "Core", x: 300, y: 210, w: 400, h: 160 },
  { id: "front", name: "Front desk", x: 20, y: 390, w: 470, h: 190 },
  { id: "crew", name: "external crew", x: 510, y: 390, w: 470, h: 190 },
];

export const SEATS: Record<string, FloorSeat> = {
  coordinator: { room: "core", x: 420, y: 285, big: true },
  developer: { room: "core", x: 625, y: 285, short: "Developer" },
  monitoring: { room: "observe", x: 150, y: 125 },
  automation: { room: "observe", x: 150, y: 280 },
  linux: { room: "infrastructure", x: 370, y: 115 },
  network: { room: "infrastructure", x: 500, y: 115 },
  container: { room: "infrastructure", x: 630, y: 115 },
  security: { room: "security", x: 850, y: 125 },
  patching: { room: "security", x: 850, y: 280 },
  chat: { room: "front", x: 105, y: 495 },
  general: { room: "front", x: 255, y: 495 },
  nova: { room: "front", x: 405, y: 495 },
  "ext-coordinator": { room: "crew", x: 574, y: 495, short: "Lead" },
  "ext-coder": { room: "crew", x: 688, y: 495, short: "Coder" },
  "ext-reader": { room: "crew", x: 802, y: 495, short: "Reader" },
  "ext-reviewer": { room: "crew", x: 916, y: 495, short: "Reviewer" },
};

const OTHER_ROOM = "other";
const OTHER_PER_ROW = 8;
const OTHER_ROW_HEIGHT = 190;
const OTHER_TOP = 600;

export interface FloorLayout {
  rooms: FloorRoom[];
  seats: Record<string, FloorSeat>;
  height: number;
}

/** Fixed seats, plus a room called Other so that an agent nobody planned for still has a desk. */
export function layoutFloor(slugs: string[]): FloorLayout {
  const unknown = slugs.filter((slug) => !SEATS[slug]).sort();
  const seats: Record<string, FloorSeat> = {};
  for (const slug of slugs) if (SEATS[slug]) seats[slug] = SEATS[slug];
  if (!unknown.length) return { rooms: ROOMS, seats, height: WORLD_HEIGHT };

  const rows = Math.ceil(unknown.length / OTHER_PER_ROW);
  const cell = 960 / OTHER_PER_ROW;
  unknown.forEach((slug, index) => {
    const row = Math.floor(index / OTHER_PER_ROW);
    seats[slug] = { room: OTHER_ROOM, x: 20 + cell * ((index % OTHER_PER_ROW) + 0.5), y: OTHER_TOP + OTHER_ROW_HEIGHT * row + 105 };
  });
  const other: FloorRoom = { id: OTHER_ROOM, name: "Other", x: 20, y: OTHER_TOP, w: 960, h: OTHER_ROW_HEIGHT * rows };
  return { rooms: [...ROOMS, other], seats, height: OTHER_TOP + OTHER_ROW_HEIGHT * rows + 20 };
}
