import { useMemo } from "react";
import { RoundedBox } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import { makeScreenTexture } from "./textures";

interface WorkstationProps {
  slug: string;
  accent: string;
  position: [number, number, number];
  rotation?: number;
  /** Screens brighten while the agent is actually working. */
  active?: boolean;
  dimmed?: boolean;
  hovered?: boolean;
  /** Clicking the desk selects the agent, same as clicking its robot -
   * never navigates away from the floor (see OpsFloorAgentPanel). */
  onClick?: () => void;
  onDoubleClick?: () => void;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
}

function Monitor({
  texture,
  width,
  height,
  position,
  rotationY = 0,
  intensity,
}: {
  texture: THREE.Texture;
  width: number;
  height: number;
  position: [number, number, number];
  rotationY?: number;
  intensity: number;
}) {
  return (
    <group position={position} rotation={[-0.08, rotationY, 0]}>
      {/* bezel */}
      <RoundedBox args={[width + 0.12, height + 0.12, 0.08]} radius={0.03} smoothness={3} castShadow>
        <meshStandardMaterial color="#05080C" metalness={0.7} roughness={0.35} />
      </RoundedBox>
      {/* small bezel status LED */}
      <mesh position={[0, -height / 2 - 0.02, 0.045]}>
        <sphereGeometry args={[0.02, 8, 8]} />
        <meshStandardMaterial color="#00D9FF" emissive="#00D9FF" emissiveIntensity={2} toneMapped={false} />
      </mesh>
      {/* emissive screen - the texture is both the colour and the light */}
      <mesh position={[0, 0, 0.045]}>
        <planeGeometry args={[width, height]} />
        <meshStandardMaterial map={texture} emissive="#ffffff" emissiveMap={texture} emissiveIntensity={intensity} toneMapped={false} roughness={0.9} />
      </mesh>
      {/* stand */}
      <mesh position={[0, -height / 2 - 0.12, -0.05]}>
        <cylinderGeometry args={[0.05, 0.07, 0.24, 10]} />
        <meshStandardMaterial color="#1b2333" metalness={0.8} roughness={0.4} />
      </mesh>
    </group>
  );
}

/**
 * A futuristic computer workstation: desk slab on a pedestal with an
 * under-desk LED strip, three monitors (one large, two angled side
 * screens) showing real per-agent content, keyboard, a small PC tower
 * with status LEDs and an office chair.
 */
export function Workstation({
  slug,
  accent,
  position,
  rotation = 0,
  active = false,
  dimmed = false,
  hovered = false,
  onClick,
  onDoubleClick,
  onPointerOver,
  onPointerOut,
}: WorkstationProps) {
  const mainTex = useMemo(() => makeScreenTexture(slug, accent, "main"), [slug, accent]);
  const sideTex = useMemo(() => makeScreenTexture(slug, accent, "side"), [slug, accent]);
  const intensity = (dimmed ? 0.35 : active ? 1.6 : 1.05) * (hovered ? 1.35 : 1);
  const deskMat = { color: "#111A24", metalness: 0.6, roughness: 0.4 };
  const dark = { color: "#0A1119", metalness: 0.75, roughness: 0.4 };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onClick?.();
  };
  const handleDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onDoubleClick?.();
  };

  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      {/* Desk width in the design contract (1.6-1.8m) is a little under
          half this assembly's original size - scaling the whole desk
          uniformly keeps every part (monitors, keyboard, tower, chair)
          proportionate instead of hand-rescaling each number. */}
      <group scale={[0.53, 0.62, 0.53]}>
      {/* desk slab */}
      <RoundedBox args={[3.4, 0.12, 1.5]} radius={0.04} smoothness={3} position={[0, 1.02, 0]} castShadow receiveShadow>
        <meshStandardMaterial {...deskMat} />
      </RoundedBox>
      {/* pedestal + feet */}
      <mesh position={[0, 0.5, -0.2]} castShadow>
        <boxGeometry args={[2.6, 0.9, 0.6]} />
        <meshStandardMaterial {...dark} />
      </mesh>
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[3.0, 0.1, 1.2]} />
        <meshStandardMaterial {...dark} />
      </mesh>
      {/* under-desk LED strip along the front edge */}
      <mesh position={[0, 0.94, 0.72]}>
        <boxGeometry args={[3.2, 0.03, 0.04]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={dimmed ? 0.3 : 1.8} toneMapped={false} />
      </mesh>

      {/* monitors */}
      <Monitor texture={mainTex} width={1.55} height={0.95} position={[0, 1.83, -0.45]} intensity={intensity} />
      <Monitor texture={sideTex} width={1.05} height={0.82} position={[-1.32, 1.77, -0.3]} rotationY={0.45} intensity={intensity * 0.9} />
      <Monitor texture={sideTex} width={1.05} height={0.82} position={[1.32, 1.77, -0.3]} rotationY={-0.45} intensity={intensity * 0.9} />

      {/* keyboard + mouse */}
      <RoundedBox args={[1.1, 0.05, 0.36]} radius={0.02} smoothness={2} position={[-0.1, 1.11, 0.3]} castShadow>
        <meshStandardMaterial color="#141c2e" metalness={0.5} roughness={0.5} />
      </RoundedBox>
      {Array.from({length:36}, (_,i) => <mesh key={i} position={[-0.54+(i%12)*0.078,1.14,0.21+Math.floor(i/12)*0.08]}>
        <boxGeometry args={[0.060,0.014,0.055]} /><meshStandardMaterial color="#627485" metalness={0.25} roughness={0.4} />
      </mesh>)}
      <RoundedBox args={[0.18, 0.06, 0.28]} radius={0.04} smoothness={3} position={[0.65, 1.11, 0.32]}>
        <meshStandardMaterial color="#141c2e" metalness={0.5} roughness={0.5} />
      </RoundedBox>

      {/* small PC tower beside the desk */}
      <group position={[2.05, 0, 0.1]}>
        <RoundedBox args={[0.5, 1.15, 0.95]} radius={0.04} smoothness={3} position={[0, 0.58, 0]} castShadow>
          <meshStandardMaterial {...dark} />
        </RoundedBox>
        {[0.85, 0.7].map((y, i) => (
          <mesh key={y} position={[0, y, 0.49]}>
            <boxGeometry args={[0.06, 0.06, 0.02]} />
            <meshStandardMaterial color={i === 0 ? "#20E69A" : accent} emissive={i === 0 ? "#20E69A" : accent} emissiveIntensity={2} toneMapped={false} />
          </mesh>
        ))}
      </group>

      {/* chair */}
      <group position={[0.85, 0, 1.23]} rotation={[0, -1.05, 0]}>
        <mesh position={[0, 0.3, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.6, 10]} />
          <meshStandardMaterial {...dark} />
        </mesh>
        <mesh position={[0, 0.03, 0]}>
          <cylinderGeometry args={[0.38, 0.38, 0.06, 20]} />
          <meshStandardMaterial {...dark} />
        </mesh>
        <RoundedBox args={[0.7, 0.14, 0.7]} radius={0.06} smoothness={3} position={[0, 0.66, 0]} castShadow>
          <meshStandardMaterial color="#182238" metalness={0.3} roughness={0.7} />
        </RoundedBox>
        <RoundedBox args={[0.68, 0.8, 0.12]} radius={0.06} smoothness={3} position={[0, 1.12, -0.32]} castShadow>
          <meshStandardMaterial color="#182238" metalness={0.3} roughness={0.7} />
        </RoundedBox>
        <mesh position={[0, 1.1, -0.26]}>
          <boxGeometry args={[0.5, 0.03, 0.01]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>
      </group>
      </group>

      {/* the screens' glow onto the desk and the robot */}
      <pointLight position={[0, 1.15, 0.3]} color={accent} intensity={dimmed ? 0 : active ? 1.2 : 0.7} distance={4} decay={2} />
    </group>
  );
}
