import { useRef } from "react";
import { RoundedBox } from "./BeveledBox";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { AgentVisualState } from "@/lib/opsFloorTypes";
export type RobotPose = "stand" | "type" | "point" | "lean";
interface RobotProps {
  color: string; secondary?: string; glow: string; state: AgentVisualState;
  pose: RobotPose; target: [number, number, number]; yaw?: number; scale?: number;
  seated?: boolean; hovered?: boolean; offline?: boolean;
  onClick?: () => void; onDoubleClick?: () => void; onPointerOver?: () => void; onPointerOut?: () => void;
}
/** Authored in metres: bevelled PBR shell, inset glass visor, articulated
 * actuators and grippers. All detail is actual geometry, including at focus. */
export function Robot({ color, secondary = "#405363", glow, state, target, yaw = 0, scale = 1, seated = false,
  hovered = false, offline = false, onClick, onDoubleClick, onPointerOver, onPointerOut }: RobotProps) {
  const head = useRef<THREE.Group>(null), torso = useRef<THREE.Group>(null);
  const left = useRef<THREE.Group>(null), right = useRef<THREE.Group>(null);
  const busy = !offline && (state === "working" || state === "investigating");
  const failed = state === "error", accent = failed ? "#FF4D67" : glow;
  const shell = { color, metalness: 0.35, roughness: 0.30, clearcoat: 0.35, clearcoatRoughness: 0.22 };
  const trim = { color: secondary, metalness: 0.5, roughness: 0.28 };
  const joint = { color: "#111820", metalness: 0.55, roughness: 0.28 };
  const emission = offline ? 0 : hovered ? 1.3 : 0.8;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + target[0] * 0.7;
    if (head.current) {
      head.current.rotation.y = offline || failed ? 0 : Math.sin(t * 0.42) * 0.13 + (busy ? -0.16 : 0);
      head.current.rotation.x = offline ? 0.16 : state === "investigating" ? -0.10 : Math.sin(t * 0.55) * 0.025;
    }
    if (torso.current) torso.current.rotation.z = offline || failed ? 0 : Math.sin(t * 0.7) * 0.006;
    [left, right].forEach((ref, i) => { if (ref.current) ref.current.rotation.x = seated ? -0.65 + (busy ? Math.sin(t * 6 + i * Math.PI) * 0.07 : 0) : 0.06; });
  });
  return <group name="service-robot" position={target} rotation={[0, yaw, 0]} scale={scale}
    onClick={(e) => { e.stopPropagation(); onClick?.(); }} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
    <group position={[0, seated ? 0.035 : 0.36, 0]} ref={torso}>
      <RoundedBox args={[0.32, 0.12, 0.25]} radius={0.045} smoothness={6} castShadow><meshStandardMaterial {...joint} /></RoundedBox>
      {[-1, 1].map(side => <group key={side} position={[side * 0.105, -0.015, 0]} rotation={[seated ? -Math.PI / 2 : 0, 0, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.065, 0.065, 0.10, 48]} /><meshStandardMaterial {...trim} /></mesh>
        <RoundedBox args={[0.125, 0.18, 0.13]} position={[0, -0.09, 0]} radius={0.045} smoothness={6} castShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
        <group position={[0, -0.19, 0]} rotation={[seated ? Math.PI / 2 : 0, 0, 0]}>
          <mesh><sphereGeometry args={[0.061, 32, 24]} /><meshStandardMaterial {...joint} /></mesh>
          <RoundedBox args={[0.115, 0.14, 0.12]} position={[0, -0.09, 0]} radius={0.035} smoothness={6} castShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
          <RoundedBox args={[0.15, 0.065, 0.23]} position={[0, -0.17, 0.045]} radius={0.026} smoothness={6} castShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
          <RoundedBox args={[0.155, 0.025, 0.23]} position={[0, -0.205, 0.045]} radius={0.01} smoothness={4}><meshStandardMaterial {...joint} /></RoundedBox>
        </group>
      </group>)}
      <RoundedBox args={[0.37, 0.34, 0.29]} position={[0, 0.225, 0]} radius={0.10} smoothness={8} castShadow receiveShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
      <RoundedBox args={[0.27, 0.22, 0.04]} position={[0, 0.23, 0.14]} radius={0.045} smoothness={6}><meshStandardMaterial {...trim} /></RoundedBox>
      <RoundedBox args={[0.17, 0.105, 0.014]} position={[0, 0.25, 0.166]} radius={0.025} smoothness={5}><meshPhysicalMaterial color="#02070B" roughness={0.1} metalness={0.15} /></RoundedBox>
      <mesh position={[0, 0.25, 0.176]}><boxGeometry args={[0.085, 0.012, 0.004]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={emission} /></mesh>
      <RoundedBox args={[0.25, 0.24, 0.04]} position={[0, 0.22, -0.145]} radius={0.035} smoothness={5}><meshStandardMaterial {...trim} /></RoundedBox>
      {[0, 1, 2, 3].map(i => <mesh key={i} position={[0, 0.19 + i * 0.027, -0.17]}><boxGeometry args={[0.16, 0.008, 0.006]} /><meshStandardMaterial {...joint} /></mesh>)}
      <mesh position={[0, 0.435, 0]}><cylinderGeometry args={[0.075, 0.09, 0.09, 48]} /><meshStandardMaterial {...joint} /></mesh>
      <group ref={head} position={[0, 0.65, 0]}>
        <RoundedBox args={[0.46, 0.39, 0.40]} radius={0.125} smoothness={10} castShadow receiveShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
        <RoundedBox args={[0.415, 0.315, 0.095]} position={[0, -0.005, 0.16]} radius={0.09} smoothness={9}><meshStandardMaterial {...trim} /></RoundedBox>
        <RoundedBox args={[0.37, 0.275, 0.08]} position={[0, -0.005, 0.19]} radius={0.085} smoothness={9}><meshPhysicalMaterial color="#02070B" metalness={0.15} roughness={0.10} clearcoat={1} clearcoatRoughness={0.08} /></RoundedBox>
        {[-1, 1].map(side => <group key={side}>
          <RoundedBox args={[0.033, 0.085, 0.012]} radius={0.015} smoothness={6} position={[side * 0.085, 0, 0.233]}><meshStandardMaterial color={offline ? "#111820" : "#BDEFFF"} emissive={accent} emissiveIntensity={emission} toneMapped={false} /></RoundedBox>
          <group position={[side * 0.237, 0, -0.015]} rotation={[0, 0, Math.PI / 2]}>
            <mesh castShadow><cylinderGeometry args={[0.095, 0.095, 0.035, 64]} /><meshStandardMaterial {...trim} /></mesh>
            <mesh position={[0, side * 0.022, 0]}><cylinderGeometry args={[0.07, 0.07, 0.012, 64]} /><meshPhysicalMaterial {...shell} /></mesh>
            <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, side * 0.03, 0]}><torusGeometry args={[0.055, 0.005, 12, 64]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={emission * 0.7} /></mesh>
          </group>
        </group>)}
        <RoundedBox args={[0.13, 0.023, 0.17]} radius={0.01} smoothness={5} position={[0, 0.194, -0.025]}><meshStandardMaterial {...trim} /></RoundedBox>
        <mesh position={[0.065, 0.21, -0.07]}><sphereGeometry args={[0.017, 24, 16]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={emission} /></mesh>
      </group>
      {[-1, 1].map((side, i) => <group key={side} position={[side * 0.23, 0.34, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[0.083, 0.083, 0.115, 48]} /><meshStandardMaterial {...joint} /></mesh>
        <mesh rotation={[0, 0, Math.PI / 2]} position={[side * 0.045, 0, 0]}><cylinderGeometry args={[0.067, 0.067, 0.038, 48]} /><meshPhysicalMaterial {...shell} /></mesh>
        <group ref={i === 0 ? left : right}>
          <RoundedBox args={[0.10, 0.19, 0.11]} radius={0.04} smoothness={7} position={[0, -0.115, 0]} castShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
          <group position={[0, -0.23, 0]} rotation={[-0.95, 0, 0]}>
            <mesh><sphereGeometry args={[0.055, 32, 24]} /><meshStandardMaterial {...joint} /></mesh>
            <RoundedBox args={[0.105, 0.16, 0.12]} radius={0.045} smoothness={7} position={[0, -0.10, 0]} castShadow><meshPhysicalMaterial {...shell} /></RoundedBox>
            <mesh position={[0, -0.20, 0]}><sphereGeometry args={[0.039, 24, 20]} /><meshStandardMaterial {...joint} /></mesh>
            <RoundedBox args={[0.10, 0.065, 0.065]} radius={0.02} smoothness={5} position={[0, -0.235, 0]}><meshStandardMaterial {...trim} /></RoundedBox>
            {[-1, 1].map(finger => <RoundedBox key={finger} args={[0.028, 0.05, 0.045]} radius={0.012} smoothness={5} position={[finger * 0.032, -0.28, 0.01]}><meshPhysicalMaterial {...shell} /></RoundedBox>)}
          </group>
        </group>
      </group>)}
      {state === "investigating" && !offline && [0, 1, 2].map(i => <mesh key={i} position={[0.30 + i * 0.055, 0.75 + Math.sin(i) * 0.07, 0.12]}><sphereGeometry args={[0.008, 12, 8]} /><meshBasicMaterial color="#00D9FF" /></mesh>)}
    </group>
  </group>;
}
