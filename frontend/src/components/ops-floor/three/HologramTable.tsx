import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { makeGlobeTexture } from "./textures";

interface HologramTableProps {
  position: [number, number, number];
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** The Coordinator's own live state color (see opsFloorTypes.STATE_COLOR) -
   * this table IS the Coordinator's presence on the floor (no separate
   * robot), so the hologram itself carries its status instead. */
  glowColor?: string;
  hovered?: boolean;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
}

const CYAN = "#00D9FF";
const RING_INNER = "#0B6F94";

/**
 * The room's centrepiece: a ~4.2m raised circular command platform (design
 * contract §COORDINATOR) with an illuminated rim and ring channels, plus a
 * floating ~1.5m holographic globe (wireframe sphere + bright core +
 * orbiting rings) that projects cyan light onto the surrounding floor.
 */
export function HologramTable({
  position,
  onClick,
  onDoubleClick,
  glowColor = CYAN,
  hovered = false,
  onPointerOver,
  onPointerOut,
}: HologramTableProps) {
  const globeTexture = useMemo(makeGlobeTexture, []);
  const globe = useRef<THREE.Group>(null);
  const ringA = useRef<THREE.Mesh>(null);
  const ringB = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (globe.current) {
      globe.current.rotation.y = t * 0.35;
      globe.current.position.y = 1.55 + Math.sin(t * 1.2) * 0.05;
    }
    if (ringA.current) ringA.current.rotation.z = t * 0.6;
    if (ringB.current) ringB.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.4) * 0.3;
    const pulse = 0.85 + Math.sin(t * 2) * 0.15;
    const boost = hovered ? 1.35 : 1;
    if (light.current) light.current.intensity = 4 * pulse * boost;
  });

  const steel = { color: "#0E1723", metalness: 0.85, roughness: 0.3 };

  return (
    <group position={position} onClick={onClick} onDoubleClick={onDoubleClick} onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
      {/* platform: ~4.2m diameter, ~0.35m tall */}
      <mesh position={[0, 0.1, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[2.05, 2.15, 0.2, 48]} />
        <meshStandardMaterial color="#071725" metalness={0.8} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.28, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[1.95, 2.02, 0.16, 48]} />
        <meshStandardMaterial {...steel} />
      </mesh>
      {/* structural segments around the drum */}
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * 2.05, 0.2, Math.sin(a) * 2.05]} rotation={[0, -a, 0]}>
            <boxGeometry args={[0.08, 0.3, 0.3]} />
            <meshStandardMaterial color="#152436" metalness={0.9} roughness={0.25} />
          </mesh>
        );
      })}
      {/* outer + inner illuminated rim */}
      <mesh position={[0, 0.36, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.0, 0.055, 16, 64]} />
        <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      {/* lit channel rings on the top surface */}
      <mesh position={[0, 0.37, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.72, 1.82, 64]} />
        <meshStandardMaterial color={RING_INNER} emissive={RING_INNER} emissiveIntensity={1.4} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.37, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.16, 64]} />
        <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={1.2} toneMapped={false} side={THREE.DoubleSide} />
      </mesh>
      {/* glass top */}
      <mesh position={[0, 0.39, 0]}>
        <cylinderGeometry args={[1.7, 1.7, 0.04, 48]} />
        <meshPhysicalMaterial color="#071725" transparent opacity={0.08} roughness={0.05} metalness={0.1} />
      </mesh>
      {/* projection cone */}
      <mesh position={[0, 0.95, 0]}>
        <coneGeometry args={[0.75, 1.3, 32, 1, true]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {/* hologram - ~1.5m diameter, this IS the Coordinator; its color is
          the Coordinator's live state (idle/working/waiting/error) */}
      <group ref={globe} position={[0, 1.55, 0]}>
        <mesh>
          <sphereGeometry args={[0.73, 48, 32]} />
          <meshBasicMaterial map={globeTexture} color="#BDEFFF" transparent opacity={0.72} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.755, 32, 16]} />
          <meshBasicMaterial color={glowColor} wireframe transparent opacity={0.05} />
        </mesh>
        <mesh ref={ringA} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.0, 0.018, 8, 64]} />
          <meshStandardMaterial color={glowColor} emissive={glowColor} emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
        <mesh ref={ringB} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.89, 0.014, 8, 64]} />
          <meshStandardMaterial color="#bfe6ff" emissive="#bfe6ff" emissiveIntensity={1.2} toneMapped={false} />
        </mesh>
        {/* data motes */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2;
          const r = 0.82 + (i % 3) * 0.09;
          return (
            <mesh key={i} position={[Math.cos(a) * r, Math.sin(a * 2) * 0.25, Math.sin(a) * r]}>
              <sphereGeometry args={[0.028, 8, 8]} />
              <meshStandardMaterial color="#e6f8ff" emissive="#e6f8ff" emissiveIntensity={3} toneMapped={false} />
            </mesh>
          );
        })}
      </group>
      <pointLight ref={light} position={[0, 1.6, 0]} color={glowColor} intensity={4} distance={12} decay={2} />
      {/* light pooling on the floor around the table */}
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.3, 2.9, 64]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.008} depthWrite={false} />
      </mesh>
    </group>
  );
}
