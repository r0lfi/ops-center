import { MeshReflectorMaterial } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";

import { ROOM_D, ROOM_H, ROOM_W } from "./layout";
import type { AgentVisual } from "@/lib/opsFloorTypes";
import { makeFloorTexture, makeOperationsDisplayTexture, makePlatformPanelTexture } from "./textures";

const CYAN = "#00D9FF";
const AMBER = "#FFC247";

interface Zone {
  center: [number, number];
  color: string;
  /** ~20% brighter border when this agent is the selected one (design
   * contract §SELECTED AGENT). */
  selected?: boolean;
}

/**
 * The physical room: dark graphite floor, back and side walls with panel
 * seams, structural columns, lit trim, the Ops Center wall display,
 * secondary wall dashboards, and thin neon floor-zone outlines (not solid
 * LED strips - a 3-5px-equivalent glowing border per the design contract).
 */
export function Room({ zones, agents }: { zones: Zone[]; agents: AgentVisual[] }) {
  const floorTex = useMemo(() => makeFloorTexture(), []);
  const liveDisplay = useMemo(() => makeOperationsDisplayTexture(agents), [agents]);
  const platformPanel = useMemo(() => makePlatformPanelTexture(), []);

  const wall = { color: "#070C13", metalness: 0.4, roughness: 0.75 };
  const panel = { color: "#0A121C", metalness: 0.5, roughness: 0.6 };
  const column = { color: "#0E1723", metalness: 0.7, roughness: 0.4 };
  const backZ = -ROOM_D / 2;
  const halfW = ROOM_W / 2;

  return (
    <group>
      {/* floor - dark graphite metal with subtle (not mirror) reflections */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[ROOM_W + 4, ROOM_D + 4]} />
        <MeshReflectorMaterial map={floorTex} color="#8799AD" metalness={0.25} roughness={0.58} resolution={512} blur={[160, 80]} mixBlur={0.85} mixStrength={0.6} mirror={0.18} depthScale={0.2} minDepthThreshold={0.4} maxDepthThreshold={1.4} />
      </mesh>

      {/* back wall + panel seams */}
      <mesh position={[0, ROOM_H / 2, backZ - 0.3]} receiveShadow>
        <boxGeometry args={[ROOM_W + 2, ROOM_H, 0.6]} />
        <meshStandardMaterial {...wall} />
      </mesh>
      <mesh position={[0, ROOM_H / 2, backZ - 0.005]}>
        <planeGeometry args={[ROOM_W + 1.6, ROOM_H - 0.4]} />
        <meshStandardMaterial {...panel} />
      </mesh>
      {Array.from({ length: 9 }, (_, i) => (
        <mesh key={i} position={[-halfW + 1 + i * (ROOM_W / 8), ROOM_H / 2, backZ + 0.01]}>
          <boxGeometry args={[0.05, ROOM_H, 0.02]} />
          <meshStandardMaterial color="#162433" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      {/* side walls (open toward the camera) */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[s * (halfW + 0.3), ROOM_H / 2, -2]} receiveShadow>
          <boxGeometry args={[0.6, ROOM_H, ROOM_D - 5]} />
          <meshStandardMaterial {...wall} />
        </mesh>
      ))}
      {/* columns */}
      {[
        [-halfW + 0.5, backZ + 0.7],
        [halfW - 0.5, backZ + 0.7],
        [-halfW + 0.5, 1.2],
        [halfW - 0.5, 1.2],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, ROOM_H / 2, 0]} castShadow>
            <boxGeometry args={[0.7, ROOM_H, 0.7]} />
            <meshStandardMaterial {...column} />
          </mesh>
          <mesh position={[0, ROOM_H / 2, 0.37]}>
            <boxGeometry args={[0.06, ROOM_H - 0.5, 0.02]} />
            <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={1.4} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* lit trim along the wall base and top */}
      <mesh position={[0, 0.05, backZ + 0.02]}>
        <boxGeometry args={[ROOM_W + 1, 0.04, 0.04]} />
        <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={1.8} toneMapped={false} />
      </mesh>
      <mesh position={[0, ROOM_H - 0.12, backZ + 0.02]}>
        <boxGeometry args={[ROOM_W + 1, 0.04, 0.04]} />
        <meshStandardMaterial color={AMBER} emissive={AMBER} emissiveIntensity={1} toneMapped={false} />
      </mesh>

      {/* Main wall display: branding remains present, but the screen is an
          operational surface showing live coordinator/agent traffic. */}
      <group position={[0, ROOM_H * 0.68, backZ + 0.08]}>
        <mesh>
          <boxGeometry args={[14.2, 3.05, 0.14]} />
          <meshStandardMaterial color="#0A121C" metalness={0.8} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0, 0.08]}>
          <planeGeometry args={[13.85, 2.75]} />
          <meshStandardMaterial map={liveDisplay} emissive="#ffffff" emissiveMap={liveDisplay} emissiveIntensity={1.05} toneMapped={false} />
        </mesh>
        <pointLight position={[0, -0.4, 1.4]} color="#00B8FF" intensity={4.5} distance={8} decay={2} />
      </group>
      {/* Platform panels live on the side walls so they never compete with
          the main live operations display on the rear wall. */}
      <group position={[-halfW - 0.02, ROOM_H * 0.58, -3.0]} rotation={[0, Math.PI / 2, 0]}>
        <mesh><boxGeometry args={[2.5, 1.25, 0.10]} /><meshStandardMaterial color="#0A121C" metalness={0.8} roughness={0.3} /></mesh>
        <mesh position={[0, 0, 0.06]}><planeGeometry args={[2.28, 1.03]} /><meshStandardMaterial map={platformPanel} emissive="#ffffff" emissiveMap={platformPanel} emissiveIntensity={0.8} toneMapped={false} /></mesh>
      </group>
      <group position={[halfW + 0.02, ROOM_H * 0.58, -3.0]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh><boxGeometry args={[2.5, 1.25, 0.10]} /><meshStandardMaterial color="#0A121C" metalness={0.8} roughness={0.3} /></mesh>
        <mesh position={[0, 0, 0.06]}><planeGeometry args={[2.28, 1.03]} /><meshStandardMaterial map={platformPanel} emissive="#ffffff" emissiveMap={platformPanel} emissiveIntensity={0.8} toneMapped={false} /></mesh>
      </group>

      {/* workstation floor zones - a thin glowing rounded-rectangle
          outline (not a filled LED strip), matching the contract's
          "3-5px at normal camera distance" neon border look. */}
      {zones.map((zone, i) => (
        <ZoneOutline key={i} center={zone.center} color={zone.color} selected={zone.selected} />
      ))}
    </group>
  );
}

/** A ~3m x 2.4m rounded-rectangle neon outline lying flat on the floor,
 * built from four thin bars + rounded corner arcs so it reads as one
 * continuous glowing border rather than four disjoint segments. ~20%
 * brighter + slightly thicker when its agent is selected. */
function ZoneOutline({ center: [cx, cz], color, selected }: { center: [number, number]; color: string; selected?: boolean }) {
  const w = 3;
  const d = 2.4;
  const r = 0.35;
  const thickness = 0.035;
  const glow = selected ? 2.6 : 2.2;
  const straightW = w - r * 2;
  const straightD = d - r * 2;

  return (
    <group position={[cx, 0.015, cz]}>
      {/* straight edges */}
      <mesh position={[0, 0, -d / 2]}>
        <boxGeometry args={[straightW, 0.01, thickness]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0, d / 2]}>
        <boxGeometry args={[straightW, 0.01, thickness]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} toneMapped={false} />
      </mesh>
      <mesh position={[-w / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <boxGeometry args={[straightD, 0.01, thickness]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} toneMapped={false} />
      </mesh>
      <mesh position={[w / 2, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <boxGeometry args={[straightD, 0.01, thickness]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} toneMapped={false} />
      </mesh>
      {/* rounded corners */}
      {[
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * (w / 2 - r), 0, sz * (d / 2 - r)]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[r - thickness / 2, r + thickness / 2, 16, 1, ([1, 0, 3, 2][i] * Math.PI) / 2, Math.PI / 2]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={glow} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* a small amount of light pooling onto the floor just inside the
          border, per "each border emits a small amount of light" */}
      <mesh position={[0, -0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w - 0.1, d - 0.1]} />
        <meshBasicMaterial color={color} transparent opacity={0.013} depthWrite={false} />
      </mesh>
    </group>
  );
}
