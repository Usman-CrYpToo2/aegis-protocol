import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "../idl/aegis.json";
import { LAUNCH_DISCRIMINATOR, LAUNCH_LAYOUT, decodeLaunch } from "./aegis";

type Field = { name: string; type: unknown };
const typeDef = (name: string) => idl.types.find((t) => t.name === name)!;

/** Size of a field as Borsh lays it out; only the kinds `Launch` uses are supported. */
function sizeOf(type: unknown): number {
  if (type === "pubkey") return 32;
  if (type === "u64") return 8;
  if (type === "u8") return 1;
  const defined = (type as { defined?: { name: string } }).defined;
  if (defined) {
    const def = typeDef(defined.name).type as { kind: string; variants?: { fields?: unknown }[] };
    if (def.kind === "enum" && def.variants!.every((v) => !v.fields)) return 1;
  }
  throw new Error(`unsupported field type ${JSON.stringify(type)}`);
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe("Launch layout", () => {
  it("matches the program's IDL field by field", () => {
    const fields = (typeDef("Launch").type as { fields: Field[] }).fields;
    let offset = 8;
    for (const f of fields) {
      expect(LAUNCH_LAYOUT[camel(f.name) as keyof typeof LAUNCH_LAYOUT], f.name).toBe(offset);
      offset += sizeOf(f.type);
    }
    expect(LAUNCH_LAYOUT.size).toBe(offset);
  });

  it("uses the IDL's enum order for stage and archetype", () => {
    const variants = (name: string) => (typeDef(name).type as { variants: { name: string }[] }).variants.map((v) => v.name);
    expect(variants("LaunchStage")).toEqual(["TokenCreated", "Funded", "Configured", "Live", "Graduated", "Aborted"]);
    expect(variants("RwaCurveArchetype")).toEqual(["FixedPar", "BookBuilding", "GrowthCapital"]);
  });

  it("rejects accounts that are not launches", () => {
    const data = new Uint8Array(LAUNCH_LAYOUT.size);
    expect(() => decodeLaunch(PublicKey.default, data)).toThrow("not a launch account");
    data.set(LAUNCH_DISCRIMINATOR);
    data[LAUNCH_LAYOUT.stage] = 9;
    expect(() => decodeLaunch(PublicKey.default, data)).toThrow("unknown launch stage");
    expect(() => decodeLaunch(PublicKey.default, data.subarray(0, 100))).toThrow("too short");
  });
});
