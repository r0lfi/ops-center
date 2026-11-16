import { memo } from "react";

import { lookOf } from "./office3d/geometry";

const INK = "#10151c";

/** Pixel rectangles on a 16x16 grid. */
function R({ x, y, w, h, c }: { x: number; y: number; w: number; h: number; c: string }) {
  return <rect x={x} y={y} width={w} height={h} fill={c} />;
}

function Tux() {
  return <>
    <R x={4} y={2} w={8} h={13} c="#151a21" />
    <R x={5} y={8} w={6} h={6} c="#f1f5f9" />
    <R x={5} y={4} w={2} h={2} c="#f8fafc" /><R x={9} y={4} w={2} h={2} c="#f8fafc" />
    <R x={6} y={5} w={1} h={1} c="#050709" /><R x={9} y={5} w={1} h={1} c="#050709" />
    <R x={7} y={6} w={2} h={2} c="#f59e0b" />
    <R x={3} y={14} w={4} h={2} c="#f59e0b" /><R x={9} y={14} w={4} h={2} c="#f59e0b" />
  </>;
}

/**
 * A portrait of the agent's figure in the 3D office: the same skin, hair,
 * shirt, face and headwear (office3d/geometry.ts LOOKS). The Coordinator is Tux.
 */
export const AgentFigure = memo(function AgentFigure({ slug, size = 32 }: { slug: string; size?: number }) {
  const look = lookOf(slug);
  const robot = slug === "automation";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true" className="of-figure">
      {slug === "coordinator" ? <Tux /> : <>
        <R x={2} y={12} w={12} h={4} c={look.shirt} />
        <R x={4} y={4} w={8} h={8} c={look.skin} />
        {look.extra !== "hood" && !robot && <R x={4} y={3} w={8} h={2} c={look.hair} />}
        {look.face === "of-fc-plain" && <><R x={6} y={7} w={1} h={1} c={INK} /><R x={9} y={7} w={1} h={1} c={INK} /></>}
        {look.face === "of-fc-glasses" && <><R x={5} y={6} w={2} h={2} c="#bfe9ff" /><R x={9} y={6} w={2} h={2} c="#bfe9ff" /><R x={4} y={7} w={8} h={1} c={INK} /><R x={6} y={7} w={1} h={1} c={INK} /><R x={9} y={7} w={1} h={1} c={INK} /></>}
        {look.face === "of-fc-shades" && <><R x={5} y={6} w={6} h={2} c="#050709" /><R x={6} y={6} w={1} h={1} c="#38bdf8" /></>}
        {look.face === "of-fc-beard" && <><R x={6} y={6} w={1} h={1} c={INK} /><R x={9} y={6} w={1} h={1} c={INK} /><R x={4} y={9} w={8} h={3} c={look.hair} /></>}
        {look.face === "of-fc-robot" && <><R x={5} y={7} w={2} h={1} c="#38bdf8" /><R x={9} y={7} w={2} h={1} c="#38bdf8" /><R x={6} y={10} w={4} h={1} c={INK} /></>}
        {look.extra === "redhat" && <><R x={3} y={3} w={10} h={1} c="#b91c1c" /><R x={5} y={1} w={6} h={2} c="#dc2626" /></>}
        {look.extra === "headset" && <><R x={3} y={7} w={1} h={3} c="#38bdf8" /><R x={12} y={7} w={1} h={3} c="#38bdf8" /><R x={4} y={2} w={8} h={1} c="#0d1218" /></>}
        {look.extra === "beanie" && <R x={4} y={1} w={8} h={3} c={look.hair} />}
        {look.extra === "cap" && <><R x={4} y={2} w={8} h={2} c={look.hair} /><R x={9} y={4} w={4} h={1} c={look.hair} /></>}
        {look.extra === "hood" && <><R x={3} y={2} w={10} h={3} c={look.shirt} /><R x={3} y={5} w={1} h={7} c={look.shirt} /><R x={12} y={5} w={1} h={7} c={look.shirt} /></>}
        {look.extra === "wizard" && <><R x={3} y={3} w={10} h={1} c="#3b0764" /><R x={5} y={1} w={6} h={2} c="#3b0764" /><R x={7} y={0} w={2} h={1} c="#3b0764" /></>}
        {look.extra === "antenna" && <><R x={7} y={1} w={2} h={3} c="#64748b" /><R x={6} y={0} w={4} h={1} c="#38bdf8" /></>}
      </>}
    </svg>
  );
});
