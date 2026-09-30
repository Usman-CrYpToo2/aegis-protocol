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
