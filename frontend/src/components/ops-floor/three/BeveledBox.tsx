import { useMemo } from "react";
import type { ThreeElements } from "@react-three/fiber";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

type Props = Omit<ThreeElements['mesh'], 'args'> & {
  args: [number,number,number]; radius?:number; smoothness?:number;
};
/** True rounded solid, including thin plates. Radius is clamped by Three
 * to prevent the negative extrusion depth possible with the old helper. */
export function RoundedBox({args:[w,h,d],radius=.03,smoothness=5,children,...props}:Props) {
  const geometry=useMemo(()=>new RoundedBoxGeometry(w,h,d,Math.min(8,smoothness),radius),[w,h,d,radius,smoothness]);
  return <mesh {...props} geometry={geometry}>{children}</mesh>;
}
