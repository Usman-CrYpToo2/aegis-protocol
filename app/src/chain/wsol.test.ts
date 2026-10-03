import { describe, expect, it } from "vitest";
import { FEE_ALLOWANCE, planSolBuy, rentFor, solReserve, spendableSol, WRAPPER_ACCOUNT_BYTES, WSOL_ACCOUNT_BYTES, type SolWallet } from "./wsol";

// Devnet's rate when this was written: an empty account needs 650,240 lamports.
const rate = { emptyAccount: 650_240n };

describe("deposits", () => {
  it("scales the empty-account deposit to any size, matching what the network reports", () => {
    expect(rentFor(0, rate)).toBe(650_240n);
    expect(rentFor(165, rate)).toBe(1_488_440n); // getMinimumBalanceForRentExemption(165) on devnet
    expect(rentFor(178, rate)).toBe(1_554_480n); // and (178)
  });
  it("matches the older, higher rate too", () => {
    expect(rentFor(165, { emptyAccount: 890_880n })).toBe(2_039_280n);
  });
});

describe("paying for a buy in SOL", () => {
  it("spends wrapped SOL first and wraps only the shortfall", () => {
    expect(planSolBuy(10n, 4n, true)).toEqual({ wrap: 6n, unwrap: false });
    expect(planSolBuy(3n, 4n, true)).toEqual({ wrap: 0n, unwrap: false });
    expect(planSolBuy(10n, 0n, false)).toEqual({ wrap: 10n, unwrap: true });
  });

  const wallet = (sol: bigint, wrapped = 0n, accounts = false): SolWallet => ({ sol, wrapped, hasWrappedAccount: accounts, hasWrapperAccount: accounts, rate });

  it("keeps back the fee, the wallet's floor and the deposits of the accounts the buy opens", () => {
    expect(solReserve(wallet(0n))).toBe(FEE_ALLOWANCE + rentFor(0, rate) + rentFor(WRAPPER_ACCOUNT_BYTES, rate) + rentFor(WSOL_ACCOUNT_BYTES, rate));
    expect(solReserve(wallet(0n, 0n, true))).toBe(FEE_ALLOWANCE + rentFor(0, rate));
  });

  it("never offers more than the wallet can spend and still pay for the transaction", () => {
    const w = wallet(5_000_000_000n);
    expect(spendableSol(w)).toBe(5_000_000_000n - solReserve(w));
    expect(spendableSol(w) + solReserve(w)).toBe(w.sol);
  });

  it("counts wrapped SOL as spendable, and offers nothing from SOL the reserve needs", () => {
    expect(spendableSol(wallet(1_000n, 7n, true))).toBe(7n);
    expect(spendableSol(wallet(2_000_000_000n, 1_000_000_000n, true))).toBe(3_000_000_000n - solReserve(wallet(0n, 0n, true)));
  });
});
