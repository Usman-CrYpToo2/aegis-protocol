/**
 * The issuer's share of the raise, exactly as Meteora DBC computes it (config.rs,
 * get_migration_quote_amount and get_migration_fee_distribution):
 *   pool gets    ceil(target × (100 − fee%) / 100)
 *   fee is       target − that
 *   issuer gets  floor(fee × creator% / 100)
 */
export function creatorMigrationFee(target: bigint, migrationFeePct: number, creatorPct: number): bigint {
  const toPool = (target * BigInt(100 - migrationFeePct) + 99n) / 100n;
  const fee = target - toPool;
  return (fee * BigInt(creatorPct)) / 100n;
}
