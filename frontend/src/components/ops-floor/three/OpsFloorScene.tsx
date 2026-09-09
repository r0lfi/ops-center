import { Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ContactShadows, Html, OrbitControls, PerspectiveCamera, Environment, Lightformer } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useNavigate } from "react-router-dom";
import * as THREE from "three";

import { STATE_COLOR, STATE_LABEL, STATIONS, type AgentVisual } from "@/lib/opsFloorTypes";
import { api, type AlertmanagerAlert, type Host } from "@/lib/api";

import { statusFor } from "../ServerRack";
import { HologramTable } from "./HologramTable";
import { CAMERA_START, POSE_BY_SLUG, ROBOT_THEME, ROOM_D, ROOM_W, STATION_WORLD, ZONE_COLOR } from "./layout";
import { Robot } from "./Robot";
import { Room } from "./Room";
import { ServerRack3D } from "./ServerRack3D";
import { Workstation } from "./Workstation";

// Design contract §SERVER RACKS.
const LED_BY_STATUS: Record<string, string> = { ok: "#20E69A", warning: "#FFC247", critical: "#FF4D67", offline: "#586A7D" };

/** A toolbar-driven camera action - `token` changes on every dispatch so an
 * identical repeated command (e.g. "rotate" twice) still fires each time. */
export interface CameraCommand {
  type: "reset" | "rotate" | "focus";
  dir?: 1 | -1;
  slug?: string;
  token: number;
}

interface OpsFloorSceneProps {
  agents: AgentVisual[];
  onSelect: (agent: AgentVisual) => void;
  /** Double-clicking an agent's robot/hologram asks the parent to focus the camera on it. */
  onFocus?: (slug: string) => void;
  zoom: number;
  autoRotate?: boolean;
  cameraCommand?: CameraCommand | null;
  /** Currently selected agent slug (design contract §SELECTED AGENT):
   * brightens that agent's floor zone, gives its nameplate a cyan
   * border, and drops a subtle ring under its chair. */
  selectedSlug?: string | null;
}

/** Small HUD nameplate that follows a station - a dark glass card with a
 * live status dot (design contract §NAME PLATES), not bare floating text. */
function Label({ position, name, state, selected, onSelect, onFocus }: {
  position: [number, number, number]; name: string; state: AgentVisual["state"] | null;
  activity?: string | null; selected?: boolean; onSelect?: () => void; onFocus?: () => void;
}) {
  const color = state ? STATE_COLOR[state] : "#586A7D";
  return <Html position={position} center zIndexRange={[10, 0]}>
    <button className="ops-nameplate" style={{ borderColor: selected ? "#00D9FF" : "#29455F" }}
      onClick={onSelect} onDoubleClick={onFocus} aria-label={`Select ${name}`}>
      <span className="ops-nameplate-name"><span style={{ width:8,height:8,borderRadius:"50%",background:color,boxShadow:`0 0 4px ${color}` }} />{name}</span>
      <span className="ops-nameplate-status" style={{ color }}>{state ? STATE_LABEL[state] : "Offline"}</span>
    </button>
  </Html>;
}

/** Apply device capabilities to real textures, and expose framebuffer metrics
 * on the canvas for regression checks without retaining WebGL objects globally. */
function RenderQuality() {
  const { gl, scene, size } = useThree();
  useEffect(() => {
    const max = Math.min(16, gl.capabilities.getMaxAnisotropy());
    scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.material) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) { value.anisotropy = max; value.needsUpdate = true; }
        }
      }
    });
    gl.domElement.dataset.anisotropy = String(max);
  }, [gl, scene, size.width, size.height]);
  const last = useRef(0);
  useFrame(({ clock }) => {
    if(clock.elapsedTime-last.current < 3)return;
    last.current=clock.elapsedTime;
    gl.domElement.dataset.drawCalls=String(gl.info.render.calls);
    gl.domElement.dataset.triangles=String(gl.info.render.triangles);
  });
  return null;
}

function useHostLeds(): string[] {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  useEffect(() => {
    api.hosts.list().then(setHosts).catch(() => {});
    api.alerts
      .list()
      .then((res) => setAlerts(res.available ? res.alerts : []))
      .catch(() => {});
  }, []);
  return hosts.map((h) => LED_BY_STATUS[statusFor(h, alerts)]);
}

/** Drives the camera from outside the canvas: toolbar reset/rotate/focus
 * commands and the auto-rotate toggle. Focus recenters the orbit target on
 * a station while preserving the current viewing angle/zoom (translates
 * both target and position by the same delta each frame, eased over
 * ~700-1200ms per the design contract's camera-animation guidance). */
function CameraRig({
  command,
  focusPositions,
  controlsRef,
}: {
  command?: CameraCommand | null;
  focusPositions: Record<string, [number, number]>;
  controlsRef: MutableRefObject<any>;
}) {
  const { camera, size } = useThree();
  const transition = useRef<{ start: number; from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null);
  const overview = () => {
    const target = new THREE.Vector3(...CAMERA_START.target);
    const position = new THREE.Vector3(...CAMERA_START.position);
    const fit = Math.max(1, 1.5 / (size.width / size.height));
    return { target, position: position.sub(target).multiplyScalar(fit).add(target) };
  };
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const next = overview();
    camera.position.copy(next.position); controls.target.copy(next.target); controls.update();
    transition.current = null;
  }, [size.width, size.height]);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !command) return;
    const next = overview();
    if (command.type === "focus" && command.slug && focusPositions[command.slug]) {
      const [x, z] = focusPositions[command.slug];
      next.target.set(x, 0.8, z);
      next.position.set(x - 2.8, 3.4, z + 5.4);
    } else if (command.type === "rotate") {
      next.target.copy(controls.target);
      next.position.copy(camera.position).sub(controls.target).applyAxisAngle(new THREE.Vector3(0,1,0), (command.dir ?? 1) * 0.25).add(controls.target);
    }
    transition.current = { start: performance.now(), from: camera.position.clone(), to:next.position, fromTarget:controls.target.clone(), toTarget:next.target };
  }, [command?.token]);
  useFrame(() => {
    const controls = controlsRef.current, move = transition.current;
    if (!controls || !move) return;
    const t = Math.min(1, (performance.now() - move.start) / 950);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
    camera.position.lerpVectors(move.from, move.to, ease);
    controls.target.lerpVectors(move.fromTarget, move.toTarget, ease);
    controls.update();
    if (t === 1) transition.current = null;
  });

  return null;
}

/** One Coordinator<->agent task-routing connection (design contract
 * §TASK ROUTING LINES): a thin, very subtle line at rest, brightening to
 * solid cyan with travelling particles while that agent is actively doing
 * something. Real data, not a decorative animation - "active" mirrors the
 * agent's own live SSE state. */
function RoutingLine({ from, to, active }: { from: [number, number]; to: [number, number]; active: boolean }) {
  const particleRef = useRef<THREE.Mesh>(null);
  const y = 0.06;

  // Built as a plain THREE.Line + primitive (not JSX <line>, which in this
  // tsconfig resolves to the DOM SVG element type, not three's) so the
  // material can be mutated directly in useFrame.
  const { line, material } = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from[0], y, from[1]), new THREE.Vector3(to[0], y, to[1])]);
    const m = new THREE.LineBasicMaterial({ color: "#08677B", transparent: true, opacity: 0.12 });
    return { line: new THREE.Line(g, m), material: m };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from[0], from[1], to[0], to[1]]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const target = active ? 0.85 : 0.12;
    material.opacity += (target - material.opacity) * 0.08;
    material.color.set(active ? "#00D9FF" : "#08677B");
    if (particleRef.current) {
      particleRef.current.visible = active;
      if (active) {
        const p = (t * 0.6) % 1;
        particleRef.current.position.set(from[0] + (to[0] - from[0]) * p, y + 0.02, from[1] + (to[1] - from[1]) * p);
      }
    }
  });

  return (
    <group>
      <primitive object={line} />
      <mesh ref={particleRef} visible={false}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshStandardMaterial color="#00D9FF" emissive="#00D9FF" emissiveIntensity={3} toneMapped={false} />
      </mesh>
    </group>
  );
}

/**
 * The 3D Ops Floor. Every robot/workstation is one real agent from
 * opsFloorTypes.STATIONS, driven by the same live agent state the 2D view
 * uses; rack LEDs on the back wall reflect the real managed hosts.
 */
export function OpsFloorScene({ agents, onSelect, onFocus, zoom, autoRotate = false, cameraCommand, selectedSlug = null }: OpsFloorSceneProps) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<string | null>(null);
  const hostLeds = useHostLeds();
  const agentBySlug = useMemo(() => Object.fromEntries(agents.map((a) => [a.slug, a])), [agents]);
  const coarsePointer = useMemo(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches, []);
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered]);

  const [coordX, coordZ] = STATION_WORLD.coordinator;

  const zones = useMemo(
    () =>
      STATIONS.filter((s) => s.slug !== "coordinator").map((s) => ({
        center: STATION_WORLD[s.slug],
        color: ZONE_COLOR[s.slug] ?? s.color,
        selected: s.slug === selectedSlug,
      })),
    [selectedSlug],
  );

  const focusPositions = STATION_WORLD;

  // The full rear wall is reserved for the presentation display and platform
  // boards; server depth remains on the two side walls.
  const backRackXs: number[] = [];
  const backZ = -ROOM_D / 2 + 0.65;
  const sideRacks: [number, number, number][] = [
    [-ROOM_W / 2 + 0.7, -3.0, Math.PI / 2],
    [-ROOM_W / 2 + 0.7, -1.0, Math.PI / 2],
    [ROOM_W / 2 - 0.7, -3.0, -Math.PI / 2],
    [ROOM_W / 2 - 0.7, -1.0, -Math.PI / 2],
  ];

  return (
    // Phones (coarse pointer) get a lighter pipeline: 1x pixel ratio, no
    // shadow maps, no bloom pass - the same scene, just cheaper per frame.
    <Canvas
      shadows="soft"
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.08 }}
      style={{ position: "absolute", inset: 0 }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.domElement.dataset.opsRenderer = "high-dpi";
      }}
    >
      <color attach="background" args={["#04070C"]} />
      <fog attach="fog" args={["#04070C", 35, 65]} />
      <PerspectiveCamera makeDefault fov={CAMERA_START.fov} position={CAMERA_START.position} zoom={zoom} near={0.3} far={80} />
      <OrbitControls
        ref={controlsRef}
        enabled={true}
        target={CAMERA_START.target}
        enablePan={false}
        autoRotate={autoRotate && !coarsePointer}
        autoRotateSpeed={0.6}
        minDistance={3}
        maxDistance={48}
        minPolarAngle={0.5}
        maxPolarAngle={1.1}
        minAzimuthAngle={-0.7}
        maxAzimuthAngle={0.7}
      />
      <CameraRig command={cameraCommand} focusPositions={focusPositions} controlsRef={controlsRef} />

      {/* lighting: dark base + cyan indirect + a ~5000K key light, per the
          design contract's §ROOM LIGHTING - most of the visual identity
          should come from monitor/floor-zone glow, not ambient fill. */}
      <ambientLight intensity={0.30} color="#C4D0DD" />
      <hemisphereLight args={["#C4D0DD", "#071019", 0.7]} />
      <directionalLight
        position={[5, 10, 6]}
        intensity={2.0}
        color="#f2f4f0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-bias={-0.0004}
      />
      <pointLight position={[-7, 3, -3.5]} color="#00B8E6" intensity={3.5} distance={9} decay={2} />
      <pointLight position={[7, 3, -3.5]} color="#00B8E6" intensity={3.5} distance={9} decay={2} />

      <Suspense fallback={null}>
        <Environment resolution={128} frames={1} environmentIntensity={0.6}>
          <Lightformer form="rect" intensity={2} color="#C4D0DD" position={[0,8,3]} rotation={[Math.PI/2,0,0]} scale={[14,10,1]} />
          <Lightformer form="rect" intensity={3} color="#00B8E6" position={[-9,4,0]} rotation={[0,Math.PI/2,0]} scale={[4,12,1]} />
          <Lightformer form="rect" intensity={2} color="#C4D0DD" position={[9,4,2]} rotation={[0,-Math.PI/2,0]} scale={[4,12,1]} />
        </Environment>
        <Room zones={zones} agents={agents} />
        <RenderQuality />
        {!coarsePointer && <ContactShadows position={[0, 0.01, 0]} scale={22} frames={1} resolution={1024} blur={1.5} far={4} opacity={0.4} color="#000000" />}

        {backRackXs.map((x, i) => (
          <ServerRack3D key={x} position={[x, 0, backZ]} seed={i} leds={hostLeds.slice(i * 2, i * 2 + 2)} onClick={() => navigate("/servers")} />
        ))}
        {sideRacks.map(([x, z, rot], i) => (
          <ServerRack3D key={`side-${i}`} position={[x, 0, z]} rotation={rot} seed={20 + i} onClick={() => navigate("/servers")} />
        ))}

        {/* Coordinator <-> agent task-routing lines - render first so
            robots/workstations draw over them */}
        {STATIONS.filter((s) => s.slug !== "coordinator").map((station) => {
          const agent = agentBySlug[station.slug];
          return <RoutingLine key={`line-${station.slug}`} from={[coordX, coordZ]} to={STATION_WORLD[station.slug]} active={!!agent && (agent.state === "working" || agent.state === "investigating")} />;
        })}

        {(() => {
          const coordAgent = agentBySlug.coordinator;
          const coordState = coordAgent?.state ?? "idle";
          const coordActivity = coordAgent && coordState !== "idle" ? coordAgent.activity : "Orchestrating agents";
          return (
            <group>
              <HologramTable
                position={[coordX, 0, coordZ]}
                glowColor="#00D9FF"
                hovered={hovered === "coordinator"}
                onClick={() => coordAgent && onSelect(coordAgent)}
                onDoubleClick={() => onFocus?.("coordinator")}
                onPointerOver={() => setHovered("coordinator")}
                onPointerOut={() => setHovered(null)}
              />
              {/* the Coordinator has no robot of its own - the hologram
                  above IS its presence on the floor (see glowColor) */}
              <Label position={[coordX, 2.4, coordZ + 0.65]} name="Coordinator" state={coordAgent ? coordState : null} activity={coordActivity} selected={selectedSlug === "coordinator"} onSelect={() => coordAgent && onSelect(coordAgent)} onFocus={() => onFocus?.("coordinator")} />
            </group>
          );
        })()}

        {/* every agent robot stays at its own desk always - the routing
            lines above (not robots walking to the center) are what shows
            live task delegation, per the design contract */}
        {STATIONS.filter((s) => s.slug !== "coordinator").map((station) => {
          const agent = agentBySlug[station.slug];
          const state = agent?.state ?? "idle";
          const glow = ROBOT_THEME[station.slug]?.accent ?? "#00D9FF";
          const isPlaceholder = station.placeholder || !agent || agent.offline;
          const pose = POSE_BY_SLUG[station.slug] ?? "stand";
          const activity = !agent || state === "idle" ? null : agent.activity;
          const theme = ROBOT_THEME[station.slug];
          const isSelected = station.slug === selectedSlug;

          const [sx, sz] = STATION_WORLD[station.slug];
          const deskPos: [number, number, number] = [sx - 0.15, 0, sz - 0.4];
          const seatTarget: [number, number, number] = [deskPos[0] + 0.45, 0.33, deskPos[2] + 0.65];
          const yaw = -1.05;

          return (
            <group key={station.slug}>
              <Workstation
                slug={station.slug}
                accent={station.color}
                position={deskPos}
                active={state === "working" || state === "investigating"}
                dimmed={isPlaceholder}
                hovered={hovered === `${station.slug}-desk`}
                onClick={() => agent && onSelect(agent)}
                onDoubleClick={() => onFocus?.(station.slug)}
                onPointerOver={() => setHovered(`${station.slug}-desk`)}
                onPointerOut={() => setHovered(null)}
              />
              <Robot
                color={isPlaceholder ? "#465362" : theme?.primary ?? station.color}
                secondary={isPlaceholder ? undefined : theme?.secondary}
                glow={glow}
                state={state}
                pose={pose}
                target={seatTarget}
                yaw={yaw}
                scale={1.12}
                seated
                offline={isPlaceholder}
                hovered={hovered === station.slug}
                onClick={() => agent && onSelect(agent)}
                onDoubleClick={() => onFocus?.(station.slug)}
                onPointerOver={() => setHovered(station.slug)}
                onPointerOut={() => setHovered(null)}
              />
              {isSelected && (
                <mesh position={[seatTarget[0], 0.02, seatTarget[2]]} rotation={[-Math.PI / 2, 0, 0]}>
                  <ringGeometry args={[0.55, 0.565, 64]} />
                  <meshBasicMaterial color="#00D9FF" transparent opacity={0.28} depthWrite={false} />
                </mesh>
              )}
              {/* above the robot's own head (seated, so higher off the
                  seat-height target than a standing robot's floor-level
                  target would need), so perspective can't slide the label
                  onto a neighbour or the table */}
              <Label
                position={[seatTarget[0], seatTarget[1] + 1.75, seatTarget[2]]}
                name={station.label}
                state={isPlaceholder ? null : state}
                activity={isPlaceholder ? null : activity}
                selected={isSelected}
                onSelect={() => agent && onSelect(agent)}
                onFocus={() => onFocus?.(station.slug)}
              />
            </group>
          );
        })}
      </Suspense>

      {(
        <EffectComposer multisampling={4}>
          <Bloom luminanceThreshold={0.88} luminanceSmoothing={0.2} intensity={0.32} mipmapBlur radius={0.32} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
