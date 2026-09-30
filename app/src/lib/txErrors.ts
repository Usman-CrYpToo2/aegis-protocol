import { SimulationError } from "../chain/trade";

export type Explained = { title: string; detail: string; retry: boolean; charged: boolean };

/** Meteora DBC errors by name (error.rs), as printed in logs: "Error Code: ExceededSlippage". */
const METEORA: Record<string, Omit<Explained, "retry" | "charged">> = {
  ExceededSlippage: {
    title: "The price moved before your trade landed",
    detail: "Someone traded first and you would have received less than your minimum. Review the new price and try again, or allow a little more price movement.",
  },
  InsufficientLiquidity: {
    title: "The sale can’t take that amount",
    detail: "Selling this much would take the price below where the sale opened. Try a smaller amount.",
  },
  NotEnoughLiquidity: { title: "The sale can’t take that amount", detail: "Try a smaller amount." },
  PoolIsCompleted: {
    title: "This sale has just filled",
    detail: "The raise reached its target and the offering is moving to its permanent pool. Trading continues there once it opens.",
  },
  AmountIsZero: { title: "Enter an amount above zero", detail: "The amount rounds to nothing in this token." },
  // Aegis bridge (programs/aegis/src/errors.rs)
  HolderNotApproved: { title: "Your wallet isn’t approved yet", detail: "Only wallets the issuer has approved can hold the security. Nothing was sent." },
  TransfersPaused: { title: "The issuer has paused transfers", detail: "The security can’t move until the issuer resumes transfers. Your wrapper still trades freely." },
  DepositPathClosed: { title: "Deposits are closed", detail: "The issuer hasn’t opened the route from the security back into the wrapper." },
  DepositPathLocked: { title: "Deposits aren’t open yet", detail: "The issuer’s rule keeps this route locked until a set date." },
  VaultUnderfunded: { title: "The escrow can’t cover that", detail: "There is less of the security in escrow than you asked for. Try a smaller amount." },
  BackingShortfall: { title: "The escrow is short", detail: "The bridge stops when the escrow holds less than it should, so nobody is paid ahead of anyone else." },
  VaultFrozen: { title: "The escrow is frozen", detail: "The issuer has frozen the escrow, so the bridge can’t move tokens." },
  InvalidLaunchStage: { title: "The bridge isn’t open", detail: "It opens when the sale graduates to its permanent pool." },
  ZeroBridgeAmount: { title: "Enter an amount above zero", detail: "Nothing to exchange." },
  // Collecting (Meteora DBC and Aegis claim_unsold)
  MigrationFeeHasBeenWithdraw: { title: "Already collected", detail: "Your share of this raise has already been paid to your wallet." },
  NotPermitToDoThisAction: { title: "Not available yet", detail: "Your share of the raise can be collected once the sale completes, and only by the wallet that created the pool." },
  NothingToClaim: { title: "Nothing to collect", detail: "There is no unsold stock owed to you for this launch." },
  UnsoldNotInVault: { title: "Nothing above the backing yet", detail: "Unsold stock is only paid from what the escrow holds above every holder’s backing." },
};

function logsOf(error: unknown): string[] {
  if (error instanceof SimulationError) return error.logs;
  const e = error as { logs?: string[]; transactionLogs?: string[] };
  return e?.logs ?? e?.transactionLogs ?? [];
}

/** Turns anything a trade can throw into a sentence a buyer can act on. */
export function explainTradeError(error: unknown): Explained {
  const message = error instanceof Error ? error.message : String(error);
  const logs = logsOf(error).join("\n");
  const all = `${message}\n${logs}`;

  if (/user rejected|rejected the request|declined|cancel/i.test(all)) {
    return { title: "Cancelled in your wallet", detail: "Nothing was sent and nothing was spent.", retry: true, charged: false };
  }
  const code = /Error Code: (\w+)/.exec(logs)?.[1];
  if (code && METEORA[code]) return { ...METEORA[code]!, retry: true, charged: false };

  if (/insufficient funds|custom program error: 0x1\b/i.test(all)) {
    return { title: "Not enough in your wallet", detail: "Your balance is lower than this trade needs. Lower the amount and try again.", retry: true, charged: false };
  }
  if (/no record of a prior credit|insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(all)) {
    return { title: "Your wallet needs a little SOL", detail: "Solana charges a small fee (and a one-time deposit for a new token account). Add some SOL and try again.", retry: true, charged: false };
  }
  if (/blockhash not found|block height exceeded|expired/i.test(all)) {
    return { title: "It took too long to confirm", detail: "The network dropped the request before it landed, so nothing was spent. Try again.", retry: true, charged: false };
  }
  if (/closed: the wrapper no longer carries/i.test(message)) {
    return { title: "This sale has closed", detail: message, retry: false, charged: false };
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(all)) {
    return { title: "Can’t reach the network", detail: "Check your connection and try again. Nothing was sent.", retry: true, charged: false };
  }
  return { title: "The trade didn’t go through", detail: message.slice(0, 200), retry: true, charged: false };
}
