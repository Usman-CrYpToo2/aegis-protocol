import { describe, expect, it } from "vitest";
import { creatorMigrationFee } from "./money";

describe("creatorMigrationFee", () => {
  it("pays the issuer its share of the migration fee", () => {
    expect(creatorMigrationFee(10_000_000_000n, 50, 100)).toBe(5_000_000_000n);
    expect(creatorMigrationFee(50_000_000_000n, 40, 100)).toBe(20_000_000_000n);
    expect(creatorMigrationFee(10_000_000_000n, 50, 80)).toBe(4_000_000_000n);
  });
  it("rounds the pool's part up and the issuer's part down, as Meteora does", () => {
    // 1,001 atoms at 50%: pool ceil(500.5)=501, fee 500, issuer 500
    expect(creatorMigrationFee(1_001n, 50, 100)).toBe(500n);
    // fee 500 at 33%: floor(165) = 165
    expect(creatorMigrationFee(1_001n, 50, 33)).toBe(165n);
  });
  it("is zero when there is no fee or no creator share", () => {
    expect(creatorMigrationFee(10_000n, 0, 100)).toBe(0n);
    expect(creatorMigrationFee(10_000n, 50, 0)).toBe(0n);
  });
});
