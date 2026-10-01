import { describe, expect, it } from "vitest";
import { SEAL_RINGS, strandPath } from "./rosette";

const points = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m): [number, number] => [Number(m[1]), Number(m[2])]);

describe("strandPath", () => {
  it("starts where the design's path starts and closes", () => {
    const d = strandPath(SEAL_RINGS[0]!.strands[0]);
    expect(d.startsWith("M260.0 0.0L260.0 -1.1L260.1 -2.2")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(points(d)).toHaveLength(3600);
  });

  it("stays between A − B and A + B from the centre", () => {
    for (const ring of SEAL_RINGS) for (const s of ring.strands) {
      const r = points(strandPath(s)).map(([x, y]) => Math.hypot(x, y));
      expect(Math.min(...r)).toBeGreaterThanOrEqual(s.a - s.b - 0.2);
      expect(Math.max(...r)).toBeLessThanOrEqual(s.a + s.b + 0.2);
    }
  });
});
