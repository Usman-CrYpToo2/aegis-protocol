import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAMM_V2_MIGRATION_CONFIG, DAMM_V2_PROGRAM_ID, MIGRATION_DAMM_V2 } from "./graduate";

describe("graduation", () => {
  it("uses Anchor's discriminator for migration_damm_v2", () => {
    expect([...MIGRATION_DAMM_V2]).toEqual([...createHash("sha256").update("global:migration_damm_v2").digest().subarray(0, 8)]);
  });
  it("pins the DAMM v2 ids to the program's own sources", () => {
    const constants = readFileSync(new URL("../../../programs/aegis/src/constants.rs", import.meta.url), "utf8");
    expect(constants).toContain(`pubkey!("${DAMM_V2_PROGRAM_ID.toBase58()}")`);
    const tests = readFileSync(new URL("../../../tests/meteora.ts", import.meta.url), "utf8");
    expect(tests).toContain(DAMM_V2_MIGRATION_CONFIG.toBase58());
  });
});
