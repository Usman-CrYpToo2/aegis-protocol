import { describe, expect, it } from "vitest";
import { mapLimit } from "./limit";

describe("mapLimit", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0, peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
  });
  it("handles nothing to do", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
