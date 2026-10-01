/**
 * The guilloché rings behind the backing seal, as on a banknote. Each strand is the curve
 * z(t) = A·e^{ipt} − B·e^{iqt}: a circle of radius A travelled p times, with a smaller circle of
 * radius B spinning q times along it. Drawn from the formula rather than stored, so the page
 * carries a few numbers instead of a few hundred kilobytes of points.
 */
export type Strand = { a: number; p: number; b: number; q: number; points: number };

export function strandPath({ a, p, b, q, points }: Strand): string {
  const out: string[] = [];
  for (let n = 0; n < points; n++) {
    const t = (2 * Math.PI * n) / points;
    const x = a * Math.cos(p * t) - b * Math.cos(q * t);
    const y = a * Math.sin(p * t) - b * Math.sin(q * t);
    out.push(`${n ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `${out.join("")}Z`;
}

/** The three rings of the seal, outermost first, each made of two strands. Taken from the design. */
export const SEAL_RINGS: { strands: [Strand, Strand]; tone: "blue" | "ink" | "ox"; width: number; spin: string }[] = [
  { strands: [{ a: 320, p: 1, b: 60, q: 16, points: 3600 }, { a: 313, p: 23, b: 70, q: 313, points: 3600 }], tone: "blue", width: 0.8, spin: "ring-outer" },
  { strands: [{ a: 225, p: 1, b: 48, q: 15, points: 5200 }, { a: 217, p: 17, b: 55, q: 217, points: 5200 }], tone: "ink", width: 0.6, spin: "ring-mid" },
  { strands: [{ a: 131, p: 11, b: 36, q: 131, points: 2400 }, { a: 125, p: 13, b: 40, q: 125, points: 2400 }], tone: "ox", width: 0.9, spin: "ring-inner" },
];
