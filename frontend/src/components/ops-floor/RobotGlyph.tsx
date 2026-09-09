/**
 * A small hand-drawn robot character - head/visor/eyes/body/arms/legs -
 * deliberately not a generic icon-font glyph. Tinted per agent (color)
 * with a glowing visor/chest-light in the current state's color (glow).
 *
 * `pose` gives each station's robot a distinct silhouette (arms typing,
 * one arm raised, leaning over the desk...) instead of every robot being
 * an identical palette-swapped clone - see IsoRoom.tsx's POSE_BY_SLUG.
 */
type RobotPose = "stand" | "type" | "point" | "lean";

interface RobotGlyphProps {
  color: string;
  glow: string;
  dimmed?: boolean;
  bob?: boolean;
  size?: number;
  pose?: RobotPose;
  /** Position within a parent SVG - a nested <svg>, not a standalone one. */
  x?: number;
  y?: number;
}

const LEFT_ARM_PIVOT = { x: 5.5, y: 27 };
const RIGHT_ARM_PIVOT = { x: 34.5, y: 27 };

const ARM_ROTATION: Record<RobotPose, { left: number; right: number }> = {
  stand: { left: 0, right: 0 },
  type: { left: 22, right: -22 },
  point: { left: 0, right: -95 },
  lean: { left: -12, right: 12 },
};

const BODY_ROTATION: Record<RobotPose, number> = {
  stand: 0,
  type: 0,
  point: 0,
  lean: -9,
};

export function RobotGlyph({
  color,
  glow,
  dimmed = false,
  bob = false,
  size = 40,
  pose = "stand",
  x = 0,
  y = 0,
}: RobotGlyphProps) {
  const arms = ARM_ROTATION[pose];
  const bodyRotation = BODY_ROTATION[pose];

  return (
    <svg
      x={x}
      y={y}
      width={size}
      height={size * 1.15}
      viewBox="0 0 40 46"
      className={bob ? "animate-[bob_2.4s_ease-in-out_infinite]" : undefined}
      style={{
        overflow: "visible",
        opacity: dimmed ? 0.35 : 1,
        filter: dimmed ? "grayscale(1)" : `drop-shadow(0 0 5px ${glow}99)`,
      }}
    >
      <g transform={bodyRotation ? `rotate(${bodyRotation} 20 34)` : undefined}>
        <line x1="20" y1="2" x2="20" y2="8" stroke={color} strokeWidth="2" />
        <circle cx="20" cy="2" r="2" fill={glow} />
        <rect x="8" y="8" width="24" height="16" rx="5" fill={color} stroke="#0b1220" strokeWidth="1" />
        {/* shading: a top-left highlight and a bottom shadow band per part,
            so the robot reads as a rounded solid instead of flat fills */}
        <rect x="8" y="19" width="24" height="5" rx="3" fill="#000" opacity="0.2" />
        <ellipse cx="14" cy="11" rx="5" ry="2.2" fill="#fff" opacity="0.28" />
        <rect x="12" y="13" width="16" height="7" rx="3" fill="#0b1220" />
        <rect x="13.5" y="14" width="5" height="1.5" rx="0.75" fill="#fff" opacity="0.35" />
        <circle cx="17" cy="16.5" r="1.6" fill={glow} />
        <circle cx="23" cy="16.5" r="1.6" fill={glow} />
        <rect x="10" y="26" width="20" height="14" rx="4" fill={color} stroke="#0b1220" strokeWidth="1" />
        <rect x="10" y="35" width="20" height="5" rx="3" fill="#000" opacity="0.22" />
        <ellipse cx="15" cy="29" rx="4" ry="1.6" fill="#fff" opacity="0.22" />
        <rect x="15" y="30" width="10" height="4" rx="1.5" fill={glow} opacity="0.8" />
        <g transform={`rotate(${arms.left} ${LEFT_ARM_PIVOT.x} ${LEFT_ARM_PIVOT.y})`}>
          <rect x="3" y="27" width="5" height="10" rx="2.5" fill={color} />
        </g>
        <g transform={`rotate(${arms.right} ${RIGHT_ARM_PIVOT.x} ${RIGHT_ARM_PIVOT.y})`}>
          <rect x="32" y="27" width="5" height="10" rx="2.5" fill={color} />
        </g>
        <rect x="12" y="40" width="6" height="5" rx="2" fill="#0b1220" />
        <rect x="22" y="40" width="6" height="5" rx="2" fill="#0b1220" />
      </g>
    </svg>
  );
}
