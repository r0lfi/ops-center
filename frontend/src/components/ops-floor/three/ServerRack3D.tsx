import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
interface ServerRack3DProps { position:[number,number,number]; rotation?:number; leds?:string[]; seed?:number; onClick?:()=>void; }
const H=2.65,W=1.1,D=.85;
/** Rack hardware is batched by material: hundreds of visible drives and
 * vents per rack, without hundreds of separate draw calls per rack. */
export function ServerRack3D({position,rotation=0,leds=[],seed=0,onClick}:ServerRack3DProps) {
 const led=useRef<THREE.InstancedMesh>(null);
 const geometry=useMemo(()=>{
  const groups:THREE.BufferGeometry[][]=[[],[],[],[]];
  const box=(group:number,w:number,h:number,d:number,x:number,y:number,z:number)=>groups[group].push(new THREE.BoxGeometry(w,h,d).translate(x,y,z));
  box(0,W,H,D,0,H/2,0);
  for(const x of [-.50,.50])box(1,.04,H,.06,x,H/2,.46);
  for(const y of [.055,H-.055])box(1,W,.05,.07,0,y,.46);
  for(let i=0;i<16;i++){
   const y=.18+i*.15;
   box(2,.90,.124,.055,0,y,.445);
   for(let j=0;j<5;j++)box(1,.008,.065,.01,-.24+j*.057,y,.48);
   for(const x of [-.39,.28])box(3,.025,.075,.025,x,y,.492);
   for(let j=0;j<3;j++)box(0,.04,.022,.01,.05+j*.055,y,.48);
  }
  return groups.map(parts=>{const merged=mergeGeometries(parts);parts.forEach(g=>g.dispose());return merged;});
 },[]);
 useEffect(()=>()=>geometry.forEach(g=>g.dispose()),[geometry]);
 useEffect(()=>{
  if(!led.current)return;
  const matrix=new THREE.Matrix4();
  for(let i=0;i<48;i++){
   matrix.makeTranslation(.36+(i%3)*.035,.18+Math.floor(i/3)*.15,.49);led.current.setMatrixAt(i,matrix);
   led.current.setColorAt(i,new THREE.Color(leds[Math.floor(i/3)]??(i%7===0?'#20E69A':'#268CFF')).multiplyScalar(i%3===0?1:.42));
  }
  led.current.instanceMatrix.needsUpdate=true;if(led.current.instanceColor)led.current.instanceColor.needsUpdate=true;
 },[leds]);
 useFrame(({clock})=>{if(led.current){const material=led.current.material as THREE.MeshBasicMaterial;material.opacity=.72+Math.sin(clock.elapsedTime*1.3+seed)*.12;}});
 return <group position={position} rotation={[0,rotation,0]} onClick={onClick}>
  {geometry.map((g,i)=><mesh key={i} geometry={g} castShadow={i===0} receiveShadow><meshStandardMaterial color={['#07101A','#172331','#03070C','#627485'][i]} metalness={.65} roughness={.36} /></mesh>)}
  <instancedMesh ref={led} args={[undefined,undefined,48]}><boxGeometry args={[.016,.012,.008]} /><meshBasicMaterial toneMapped={false} transparent /></instancedMesh>
  {seed%3===0&&<mesh position={[-.485,H/2,.495]}><boxGeometry args={[.009,H-.18,.01]} /><meshStandardMaterial color="#087D9B" emissive="#00B8E6" emissiveIntensity={.45} /></mesh>}
 </group>;
}
