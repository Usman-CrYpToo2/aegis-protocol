import { describe, expect, it } from "vitest";
import idl from "../idl/aegis.json";
import { PLATFORM_LAYOUT, QUOTE_LAYOUT } from "./platform";

const SIZE: Record<string, number> = { pubkey: 32, u64: 8, i64: 8, u16: 2, u8: 1, bool: 1 };
const offsets = (name: string) => {
  const fields = (idl.types.find((t) => t.name === name)!.type as { fields: { name: string; type: string }[] }).fields;
  let at = 8;
  const out: Record<string, number> = {};
  for (const f of fields) { out[f.name] = at; at += SIZE[f.type]!; }
  return { out, size: at };
};

describe("platform layouts", () => {
  it("PlatformConfig offsets match the IDL", () => {
    const { out, size } = offsets("PlatformConfig");
    const L = PLATFORM_LAYOUT;
    expect([L.feeRecipient, L.creationFee, L.isPaused, L.curveFeeBps, L.issuerCurveShare, L.aegisMigrationShare, L.aegisLpShare, L.minMigration, L.maxMigration, L.minPermanent, L.minVesting, L.maxVesting, L.minPoolFee, L.maxPoolFee]).toEqual([
      out.fee_recipient, out.creation_fee_lamports, out.is_paused, out.curve_fee_bps, out.issuer_curve_fee_share_pct, out.aegis_migration_fee_share_pct, out.aegis_lp_share_pct,
      out.min_migration_fee_pct, out.max_migration_fee_pct, out.min_issuer_permanent_pct, out.min_vesting_months, out.max_vesting_months, out.min_pool_fee_bps, out.max_pool_fee_bps,
    ]);
    expect(L.size).toBe(size);
  });
  it("QuoteToken offsets match the IDL", () => {
    const { out, size } = offsets("QuoteToken");
    expect([QUOTE_LAYOUT.mint, QUOTE_LAYOUT.decimals, QUOTE_LAYOUT.isActive, QUOTE_LAYOUT.isLegacySpl, QUOTE_LAYOUT.minRaise]).toEqual([out.mint, out.decimals, out.is_active, out.is_legacy_spl, out.min_raise]);
    expect(QUOTE_LAYOUT.size).toBe(size);
  });
});
