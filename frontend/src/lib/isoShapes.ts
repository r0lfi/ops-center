/**
 * Pure-geometry helpers for drawing isometric-styled props (desks, server
 * racks, the coordinator platform) as flat SVG polygons - three shaded
 * faces per box (top/left/right), the standard 2D-isometric-cube trick.
 * No 3D engine involved: this is 2D SVG art directed to read as a
 * physical room, per the Ops Floor's reference design (see IsoRoom.tsx).
 */

export interface Point {
  x: number;
  y: number;
}

export function pts(points: Point[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/**
 * An isometric box whose floor footprint is a diamond centered at
 * (cx, cy) with horizontal reach `dx` and vertical reach `dy` (dy should
 * be roughly half of dx for a standard 2:1 isometric look), raised by
 * `h` screen units. Returns the three visible faces as SVG point strings,
 * already in isometric-diamond space (no further projection needed).
 */
export function isoBox(cx: number, cy: number, dx: number, dy: number, h: number) {
  const N: Point = { x: cx, y: cy - dy };
  const E: Point = { x: cx + dx, y: cy };
  const S: Point = { x: cx, y: cy + dy };
  const W: Point = { x: cx - dx, y: cy };
  const up = (p: Point): Point => ({ x: p.x, y: p.y - h });

  const Nt = up(N);
  const Et = up(E);
  const St = up(S);
  const Wt = up(W);

  return {
    top: pts([Nt, Et, St, Wt]),
    left: pts([Wt, St, S, W]),
    right: pts([St, Et, E, S]),
    // The floor-level diamond outline, e.g. for a glow "landing pad" under the box.
    footprint: pts([N, E, S, W]),
    // Anchor points, for stacking a second box on top of this one, or
    // standing a robot at the box's front corner.
    frontCorner: S,
    topCenter: { x: cx, y: cy - h },
  };
}

/**
 * An isometric cylinder (the coordinator's platform/hologram table): a
 * top ellipse, a matching ellipse at the floor, and the visible front
 * arc of the "drum" wall connecting them.
 */
export function isoCylinder(cx: number, cy: number, rx: number, ry: number, h: number) {
  const topCy = cy - h;
  const drumPath = [
    `M ${(cx - rx).toFixed(1)} ${topCy.toFixed(1)}`,
    `A ${rx} ${ry} 0 0 0 ${(cx + rx).toFixed(1)} ${topCy.toFixed(1)}`,
    `L ${(cx + rx).toFixed(1)} ${cy.toFixed(1)}`,
    `A ${rx} ${ry} 0 0 1 ${(cx - rx).toFixed(1)} ${cy.toFixed(1)}`,
    "Z",
  ].join(" ");
  return { topCy, drumPath };
}
