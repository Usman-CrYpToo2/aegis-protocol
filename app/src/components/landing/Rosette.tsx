import { SEAL_RINGS, strandPath } from "../../lib/rosette";

const TONE = { blue: "#1D3A8A", ink: "#16140F", ox: "#7E2A1E" } as const;

type Ring = (typeof SEAL_RINGS)[number] & { d: string[] };
let cache: Ring[] | null = null;
const rings = () => (cache ??= SEAL_RINGS.map((r) => ({ ...r, d: r.strands.map(strandPath) })));

/**
 * The turning guilloché rings. Purely decorative: whatever sits on top of them carries the
 * meaning. `mono` draws every strand in currentColor, for use on a coloured panel.
 */
export function Rosette({ className = "", mono = false, draw = true }: { className?: string; mono?: boolean; draw?: boolean }) {
  return (
    <svg viewBox="-400 -400 800 800" aria-hidden="true" className={`${draw ? "lp-draw" : ""} ${className}`}>
      {rings().map((ring) => (
        <g key={ring.spin} className={`ring ${ring.spin}`}>
          {ring.d.map((path, j) => (
            <path key={j} d={path} fill="none" stroke={mono ? "currentColor" : TONE[ring.tone]} strokeWidth={ring.width} vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </svg>
  );
}
