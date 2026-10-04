import { TRANSFER_RESTRICTIONS_PROGRAM_ID } from "../chain/ids";
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
  // Upside Transfer Restrictions (approving investors)
  Unauthorized: { title: "This wallet can’t change the register", detail: "Only a wallet holding the security’s wallets-admin role in Upside can approve investors. Connect the wallet you launched with." },
  MaxHoldersReached: { title: "The register is full", detail: "The security has reached its maximum number of holders. Raise the limit in Upside before approving more." },
  MaxHoldersReachedInsideTheGroup: { title: "The investor group is full", detail: "The investor group has reached its maximum number of holders. Raise the group’s limit in Upside before approving more." },
  InvalidHolderIndex: { title: "The register changed while you were signing", detail: "Another approval landed first, so the holder numbers moved on. Nothing was spent. Try again." },
  AllTransfersPaused: { title: "Transfers are paused", detail: "You have paused this security. Resume transfers in Upside and try again." },
};

function logsOf(error: unknown): string[] {
  if (error instanceof SimulationError) return error.logs;
  const e = error as { logs?: string[]; transactionLogs?: string[] };
  return e?.logs ?? e?.transactionLogs ?? [];
}

/** Turns anything a trade can throw into a sentence a buyer can act on. */
/** An error that is already a plain explanation, thrown before anything is sent. */
export class PlainError extends Error {
  constructor(readonly title: string, readonly detail: string) {
    super(`${title}. ${detail}`);
  }
}

export type ErrorTable = Record<string, Omit<Explained, "retry" | "charged">>;

export function explainTradeError(error: unknown, overrides: ErrorTable = {}): Explained {
  const message = error instanceof Error ? error.message : String(error);
  const logs = logsOf(error).join("\n");
  const all = `${message}\n${logs}`;

  if (error instanceof PlainError) return { title: error.title, detail: error.detail, retry: false, charged: false };
  if (error && typeof error === "object" && "walletCancelled" in error) {
    return { title: "Cancelled", detail: "You stopped waiting for the wallet. Nothing was sent and nothing was spent; it is safe to try again.", retry: true, charged: false };
  }
  if (/user rejected|rejected the request|declined|cancel/i.test(all)) {
    return { title: "Cancelled in your wallet", detail: "Nothing was sent and nothing was spent.", retry: true, charged: false };
  }
  // Upside: a wallet with no role for this security has no role record to read.
  if (/account: authority_wallet_role\. Error Code: AccountNotInitialized/.test(logs)) return { ...METEORA.Unauthorized!, retry: false, charged: false };
  // Upside: creating an approval record that already exists.
  if (logs.includes(`Program ${TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58()} failed`) && /already in use/.test(logs)) {
    return { title: "Already on the register", detail: "At least one of these wallets is already approved. Refresh the list and try the others.", retry: false, charged: false };
  }
  const code = /Error Code: (\w+)/.exec(logs)?.[1];
  if (code && overrides[code]) return { ...overrides[code]!, retry: true, charged: false };
  if (code && METEORA[code]) return { ...METEORA[code]!, retry: true, charged: false };

  if (/insufficient funds|custom program error: 0x1\b/i.test(all)) {
    return { title: "Not enough in your wallet", detail: "Your balance is lower than this trade needs. Lower the amount and try again.", retry: true, charged: false };
  }
  if (/no record of a prior credit|insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(all)) {
    return { title: "Your wallet needs a little SOL", detail: "Solana charges a small fee (and a one-time deposit for a new token account). Add some SOL and try again.", retry: true, charged: false };
  }
  if (error && typeof error === "object" && "approvalTooSlow" in error) {
    return { title: "The approval took too long", detail: "The network accepts an approval for about a minute, so nothing was sent and nothing was spent. Try again and approve a little sooner.", retry: true, charged: false };
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
  return { title: "It didn’t go through", detail: message.slice(0, 200), retry: true, charged: false };
}

const SUPPLY_SHORT = { title: "Your supply is too small for these terms", detail: "At this opening price, the raise needs more tokens than you are issuing. Nothing was changed on-chain. Raise the price, lower the raise, or go back and issue more." };

/** Errors while issuing an asset, in the words of the step the issuer is on. */
export const ISSUE_ERRORS: ErrorTable = {
  ProtocolPaused: { title: "Aegis is paused", detail: "The platform is not accepting new launches right now. Nothing was changed; try again later." },
  InvalidLaunchStage: { title: "This step is already done", detail: "The chain shows this launch has moved past this step. The page will refresh to where you are." },
  InvalidRwaDecimals: { title: "Decimals must be 6 to 9", detail: "Meteora only accepts tokens with 6 to 9 decimals." },
  InvalidTotalSupply: { title: "Enter a supply above zero", detail: "The asset needs at least one unit." },
  TokenNameTooLong: { title: "The name is too long", detail: "Use 32 characters or fewer." },
  TokenSymbolTooLong: { title: "The symbol is too long", detail: "Use 9 characters or fewer, so the wrapper’s symbol still fits." },
  TokenUriTooLong: { title: "The link is too long", detail: "Use a link of 200 characters or fewer." },
  SupplyTooSmallForCurve: SUPPLY_SHORT,
  InvalidTokenSupply: SUPPLY_SHORT,
  RaiseBelowMinimum: { title: "The raise is below the minimum", detail: "This quote token has a minimum raise set by the platform. Raise the target." },
  MigrationFeeTooLow: { title: "Your cash share is below the platform’s floor", detail: "Take a larger share of the raise as cash." },
  MigrationFeeTooHigh: { title: "Your cash share is above the platform’s ceiling", detail: "Leave more of the raise in the trading pool." },
  InvalidLiquiditySplit: { title: "The pool split doesn’t add up", detail: "Locked forever and unlocking monthly must together make up your whole share of the pool." },
  PermanentLockTooLow: { title: "Too little is locked forever", detail: "The platform requires a minimum share of your pool liquidity to be locked for good." },
  InvalidVestingMonths: { title: "The unlock period is outside the platform’s range", detail: "Choose a number of months within the range shown." },
  InvalidFeeBps: { title: "The pool fee is outside the allowed range", detail: "Choose a fee within the range shown." },
  PriceExpansionExceedsRwaLimit: { title: "The price rises further than this sale type allows", detail: "Lower the end price or pick a sale type with a wider range." },
  PriceExpansionTooSmall: { title: "The price must rise at least a little", detail: "A completely flat price can’t be launched on a curve." },
  InvalidStartPrice: { title: "That opening price can’t be represented", detail: "Meteora can’t price a token this cheaply or this expensively. Adjust the opening price." },
  PriceExceedsMaxSqrtPrice: { title: "The price is too high for Meteora", detail: "Lower the opening price or the price range." },
  CurveSellsNothing: { title: "The sale would sell nothing", detail: "The raise is too small for this price. Raise the target or lower the price." },
  QuoteTokenNotWhitelisted: { title: "That currency isn’t approved", detail: "The platform only accepts the currencies listed." },
  QuoteTokenInactive: { title: "That currency is switched off", detail: "The platform has paused sales in this currency. Choose another." },
  SupplyCapRaised: { title: "The supply cap was raised", detail: "Your security’s maximum supply was changed after it was created, so it can no longer be escrowed safely." },
  SupplyMintedElsewhere: { title: "Tokens exist outside the escrow", detail: "Some of the security was minted somewhere else. The whole supply must be in escrow." },
  IssuerNotRegistered: { title: "Your wallet isn’t on the register", detail: "Register yourself as a holder first; the escrow can only come back to an approved wallet." },
  LaunchAlreadyLive: { title: "The sale has already started", detail: "Once buyers hold the wrapper, the escrow backs their tokens and the launch can’t be cancelled." },
};
