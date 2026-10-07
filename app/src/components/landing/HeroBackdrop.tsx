import { useEffect, useRef } from "react";

/**
 * Engraved backdrops: fine lines like those printed on share certificates and banknotes, drifting
 * slowly, over a faint paper grain. One motif, used where it fits the page:
 *
 * - `hero`: the landing page's opening. Two layers of lines moving apart, two soft lights, and a
 *   brighter patch of the same lines that follows the pointer on devices that have one.
 * - `dark`: fewer of the same lines, in paper colour, inside a dark panel.
 *
 * Only on the landing page. The app's screens stay plain paper: they are for reading numbers, and
 * a pattern squeezed into a short band reads as grain and tires the eye.
 *
 * The pattern stretches to its container's height, so line spacing depends on it: the hero's lines
 * sit about 31px apart, and a shorter container gets fewer lines to keep that spacing.
 *
 * Each layer is a strip twice the screen's width whose pattern repeats exactly halfway across, so
 * sliding it left by half loops with no seam. All of it is decorative: hidden from screen readers,
 * ignores the pointer, and holds still for reduced motion (styles.css).
 */

const PERIOD = 1440; // one repeat of the pattern, in viewBox units; the strip holds two
const HEIGHT = 1000;

/** One engraved line: two sine waves whose wavelengths divide PERIOD, so the line repeats exactly. */
function wave(base: number, a1: number, l1: number, p1: number, a2: number, l2: number, p2: number): string {
  let d = "";
  for (let x = 0; x <= PERIOD * 2; x += 12) {
    const y = base + a1 * Math.sin((2 * Math.PI * x) / l1 + p1) + a2 * Math.sin((2 * Math.PI * x) / l2 + p2);
    d += `${x === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`;
  }
  return d;
}

// Built once: the same lines every render.
const INK = Array.from({ length: 30 }, (_, i) => wave(40 + i * 31, 42, 720, i * 0.3, 16, 480, i * 0.52));
const BLUE = Array.from({ length: 16 }, (_, i) => wave(90 + i * 56, 64, 1440, i * 0.42 + 1, 22, 360, i * 0.8));
// For panels about half the hero's height: half as many lines, so the spacing stays the same.
const SPARSE = Array.from({ length: 14 }, (_, i) => wave(50 + i * 66, 42, 720, i * 0.6, 16, 480, i * 1.04));

function Strip({ paths, color, opacity, className }: { paths: string[]; color: string; opacity: number; className: string }) {
  return (
    <div className={`absolute inset-y-0 left-0 w-[200%] ${className}`}>
      <svg viewBox={`0 0 ${PERIOD * 2} ${HEIGHT}`} preserveAspectRatio="none" className="size-full" aria-hidden="true">
        <g fill="none" stroke={color} strokeOpacity={opacity} strokeWidth="1">
          {paths.map((d, i) => <path key={i} d={d} vectorEffect="non-scaling-stroke" />)}
        </g>
      </svg>
    </div>
  );
}

const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.09 0 0 0 0 0.08 0 0 0 0 0.06 0 0 0 0.07 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

/**
 * A brighter copy of the lines, shown only in a soft circle around the pointer. The circle's
 * position is two CSS variables set from pointer events, so nothing re-renders as it moves.
 */
function Spotlight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
        el.style.opacity = e.clientY >= r.top && e.clientY - r.top < r.height ? "1" : "0";
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="absolute inset-0 opacity-0 transition-opacity duration-500"
      style={{ maskImage: "radial-gradient(260px circle at var(--mx, -999px) var(--my, -999px), #000, transparent)" }}
    >
      <Strip paths={INK} color="#1d3a8a" opacity={0.32} className="lp-flow" />
    </div>
  );
}

type Variant = "hero" | "dark";

const MASKS: Record<Variant, string> = {
  // Fades in under the nav and out before the numbers, lighter behind the headline.
  hero: "linear-gradient(to bottom, transparent 0%, #000 14%, #000 72%, transparent 100%), linear-gradient(to right, rgb(0 0 0 / 0.5) 0%, rgb(0 0 0 / 0.5) 34%, #000 68%)",
  // From the panel's right edge, clear of the text on its left.
  dark: "linear-gradient(to left, #000 0%, #000 30%, transparent 75%)",
};

export function HeroBackdrop({ variant = "hero", className = "" }: { variant?: Variant; className?: string }) {
  const style = { maskImage: MASKS[variant], maskComposite: "intersect", WebkitMaskComposite: "source-in" } as const;
  if (variant === "dark") {
    return (
      <div aria-hidden="true" className={`pointer-events-none absolute -z-10 overflow-hidden ${className}`} style={style}>
        <Strip paths={SPARSE} color="#f4f1ea" opacity={0.1} className="lp-flow" />
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 -z-10 overflow-hidden ${className}`} style={style}>
      <div className="lp-glow absolute top-[18%] left-[58%] size-[900px] rounded-full" style={{ background: "radial-gradient(closest-side, rgb(29 58 138 / 0.12), transparent)" }} />
      <div className="lp-glow absolute top-[2%] left-[-8%] size-[760px] rounded-full" style={{ background: "radial-gradient(closest-side, rgb(126 42 30 / 0.08), transparent)", animationDelay: "-9s" }} />
      <Strip paths={INK} color="#16140f" opacity={0.09} className="lp-flow" />
      <Strip paths={BLUE} color="#1d3a8a" opacity={0.1} className="lp-flow-rev" />
      <Spotlight />
      <div className="absolute inset-0" style={{ backgroundImage: GRAIN }} />
    </div>
  );
}
