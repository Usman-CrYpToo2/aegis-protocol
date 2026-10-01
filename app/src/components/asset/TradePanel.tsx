import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { config, explorerUrl } from "../../config";
import { useConnectModal } from "../connect/ConnectModal";
import { confirmSignature, sendSigned } from "../../chain/send";
import { loadAsset } from "../../chain/asset";
import { GRADUATION_DEPOSIT_LAMPORTS, graduationTransactions } from "../../chain/graduate";
import type { RegistryEntry } from "../../chain/registry";
import { loadTradeAccounts, prepareTrade, type Side } from "../../chain/trade";
import { useWalletBalances } from "../../hooks/useWalletBalances";
import { formatUnits, parseUnits, sqrtPriceToQuoteAtoms, toInputText } from "../../lib/amount";
import { quoteBuy, quoteSell, remainingToFill, withSlippage, type CurveState } from "../../lib/swap";
import { explainTradeError, type Explained } from "../../lib/txErrors";

/** Enough SOL for the network fee and, on a first buy, the new token account's deposit. */
const MIN_SOL = 5_000_000n; // 0.005 SOL
const SLIPPAGES = [50, 100, 200] as const;

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "signing" | "sending" | "confirming" }
  | { kind: "done"; side: Side; paid: string; received: string; signature: string; graduated: boolean | null }
  | { kind: "failed"; error: Explained };

const STEP_TEXT = {
  checking: "Checking the latest price…",
  signing: "Approve in your wallet…",
  sending: "Sending…",
  confirming: "Confirming on-chain…",
} as const;

function Line({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 text-[14px] leading-relaxed ${strong ? "font-semibold" : ""}`}>
      <span className="text-ink2">{label}</span>
      <span className="flex-1 -translate-y-1 border-b border-dotted border-[#A89F8A]" aria-hidden="true" />
      <span className="font-mono num text-right">{children}</span>
    </div>
  );
}

/**
 * Buy or sell on an open offering. The preview is Meteora's own maths (lib/swap), the trade is
 * re-quoted against a fresh read right before the wallet opens, and it is simulated before the
 * user is asked to sign, so a trade that would fail is explained instead of signed.
 */
export function TradePanel({ entry }: { entry: RegistryEntry }) {
  const { launch, quote, detail } = entry;
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signAllTransactions } = useWallet();
  const { open: openConnect } = useConnectModal();
  const queryClient = useQueryClient();
  const inputId = useId();

  const [side, setSide] = useState<Side>("buy");
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [slippage, setSlippage] = useState<number>(100);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const inFlight = useRef(false);

  const accounts = useQuery({
    queryKey: ["tradeAccounts", config.rpcUrl, launch.address.toBase58()],
    queryFn: () => loadTradeAccounts(connection, launch),
    staleTime: Infinity,
  });
  const balances = useWalletBalances(launch.quoteMint, accounts.data?.quoteProgram ?? null, launch.crwaMint);

  const wrapper = entry.wrapperLabel?.symbol ?? "wrapper";
  const q = quote!;
  const inDecimals = side === "buy" ? q.decimals : launch.decimals;
  const inSymbol = side === "buy" ? q.symbol : wrapper;
  const outSymbol = side === "buy" ? wrapper : q.symbol;

  const state: CurveState | null =
    detail.pool && detail.terms && detail.terms.collectFeeMode === 0
      ? { sqrtPrice: detail.pool.sqrtPrice, sqrtStartPrice: detail.terms.sqrtStartPrice, migrationSqrtPrice: detail.terms.migrationSqrtPrice, curve: detail.terms.curve, feeNumerator: detail.terms.curveFeeNumerator }
      : null;

  const parsed = parseUnits(text, inDecimals);
  const preview = useMemo(() => {
    if (!state || !parsed.ok) return null;
    if (side === "buy") {
      const b = quoteBuy(state, parsed.atoms);
      // Completes the sale either by being cut short (partial fill) or by landing exactly on the end.
      return b && { spend: b.spend, out: b.out, fee: b.fee, nextSqrt: b.nextSqrt, fillsSale: b.fillsSale || b.nextSqrt >= state.migrationSqrtPrice, refunds: b.fillsSale };
    }
    const s = quoteSell(state, parsed.atoms);
    return s && { spend: parsed.atoms, out: s.out, fee: s.fee, nextSqrt: s.nextSqrt, fillsSale: false, refunds: false };
  }, [state, parsed.ok, parsed.ok && parsed.atoms, side]);

  if (!state) return null;
  // The raise is complete: the curve accepts no more trades until Meteora moves it to its pool.
  const filled = entry.raise !== null && entry.raise.raised >= entry.raise.target;
  const remaining = remainingToFill(state);
  const bal = balances.data;
  const have = side === "buy" ? bal?.quote : bal?.wrapper;
  const fmtIn = (v: bigint) => formatUnits(v, inDecimals, { maxFraction: 4 });
  const fmtOut = (v: bigint) => formatUnits(v, side === "buy" ? launch.decimals : q.decimals, { maxFraction: 4 });
  const fmtPrice = (v: bigint) => formatUnits(v, q.decimals, { maxFraction: 4, minFraction: 3 });

  // What stops the button, in the order a person would want to hear it.
  let blocker: string | null = null;
  if (!publicKey) blocker = null;
  else if (!parsed.ok) blocker = parsed.reason;
  else if (!preview) blocker = side === "sell" ? "The sale can’t take that much back. Try less." : "That amount is too small to trade.";
  else if (bal && have !== undefined && preview.spend > have) blocker = `Not enough ${inSymbol}. You have ${fmtIn(have)}.`;
  else if (bal && bal.sol < MIN_SOL) blocker = "Add a little SOL for the network fee (about 0.005 SOL).";

  const busy = phase.kind === "busy";
  const minimumOut = preview ? withSlippage(preview.out, slippage) : 0n;

  const setAmount = (atoms: bigint) => {
    setText(toInputText(atoms, inDecimals));
    setTouched(true);
  };
  const switchSide = (next: Side) => {
    if (busy) return;
    setSide(next);
    setText("");
    setTouched(false);
    setPhase({ kind: "idle" });
  };

  async function submit() {
    if (!publicKey || !preview || blocker || inFlight.current || !accounts.data || !parsed.ok) return;
    inFlight.current = true;
    const amountIn = parsed.atoms;
    try {
      // Re-read the pool and re-quote: if the price moved past what the user accepted while they
      // were deciding, say so now instead of letting the wallet sign a trade that will fail.
      setPhase({ kind: "busy", step: "checking" });
      const fresh = await loadAsset(connection, launch.realRwaMint);
      if (fresh.launch.stage !== "Live" || !fresh.detail.pool || fresh.detail.pool.isMigrated) {
        throw Object.assign(new Error("sale closed"), { logs: ["Error Code: PoolIsCompleted"] });
      }
      const freshState = { ...state!, sqrtPrice: fresh.detail.pool.sqrtPrice };
      const again = side === "buy" ? quoteBuy(freshState, amountIn) : quoteSell(freshState, amountIn);
      if (!again || again.out < minimumOut) {
        throw Object.assign(new Error("price moved"), { logs: ["Error Code: ExceededSlippage"] });
      }
      const prepared = await prepareTrade(connection, { launch: fresh.launch, pool: fresh.detail.pool, accounts: accounts.data, owner: publicKey, side, amountIn, minimumOut });

      // The buy that fills the sale also graduates it: the two permissionless graduation
      // transactions ride along, approved in the same wallet prompt, so no one is ever asked to
      // "graduate" separately. If they fail, the sale still completed and the fallback panel shows.
      const completes = side === "buy" && "fillsSale" in again && (again.fillsSale || again.nextSqrt >= state!.migrationSqrtPrice);
      const bundle = completes && signAllTransactions ? graduationTransactions(fresh.launch, publicKey, accounts.data.quoteProgram, prepared.blockhash) : [];

      setPhase({ kind: "busy", step: "signing" });
      let signature: string;
      let graduated: boolean | null = null;
      if (bundle.length) {
        const [buy, ...rest] = await signAllTransactions!([prepared.transaction, ...bundle]);
        setPhase({ kind: "busy", step: "confirming" });
        signature = await sendSigned(connection, buy!, prepared.lastValidBlockHeight, true);
        graduated = true;
        for (const tx of rest) {
          try {
            await sendSigned(connection, tx, prepared.lastValidBlockHeight, false);
          } catch {
            graduated = false;
            break;
          }
        }
      } else {
        signature = await sendTransaction(prepared.transaction, connection, { preflightCommitment: "confirmed" });
        setPhase({ kind: "busy", step: "confirming" });
        await confirmSignature(connection, signature, prepared.lastValidBlockHeight);
      }
      const spent = side === "buy" && "spend" in again ? again.spend : amountIn;
      setPhase({
        kind: "done",
        side,
        paid: `${fmtIn(spent)} ${inSymbol}`,
        received: `${fmtOut(again.out)} ${outSymbol}`,
        signature,
        graduated,
      });
      setText("");
      setTouched(false);
    } catch (e) {
      setPhase({ kind: "failed", error: explainTradeError(e) });
    } finally {
      inFlight.current = false;
      void queryClient.invalidateQueries({ queryKey: ["asset"] });
      void queryClient.invalidateQueries({ queryKey: ["registry"] });
      void queryClient.invalidateQueries({ queryKey: ["balances"] });
    }
  }

  // Once the sale fills, the graduate panel takes over; only the last buyer's receipt stays.
  if (filled && phase.kind !== "done") return null;

  const priceNow = sqrtPriceToQuoteAtoms(state.sqrtPrice, launch.decimals);
  const quickBuy = [100n, 500n, 1_000n].map((n) => n * 10n ** BigInt(q.decimals));

  return (
    <section aria-label={`Buy or sell ${wrapper}`} className="flex flex-col border border-ink bg-surface">
      {!filled && (
      <div role="tablist" aria-label="Direction" className="grid grid-cols-2 border-b border-ink">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            type="button"
            aria-selected={side === s}
            onClick={() => switchSide(s)}
            className={`min-h-12 cursor-pointer text-[15px] ${side === s ? "border-b-2 border-ink font-semibold text-ink" : "text-mute hover:text-ink"}`}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      )}

      <div className="flex flex-col gap-4 p-5">
        {phase.kind === "done" ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="kicker text-green">{phase.side === "buy" ? "Purchase complete" : "Sale complete"}</span>
            <span className="font-serif text-4xl leading-tight">{phase.received}</span>
            <span className="text-sm text-ink2">for {phase.paid}. It’s in your wallet now.</span>
            {phase.graduated !== null && (
              <span className="border-l-2 border-green pl-3 text-[13px] leading-relaxed text-ink2">
                {phase.graduated ? "Your purchase completed the sale and opened the bridge." : "Your purchase completed the sale. Opening the bridge didn’t go through; anyone can finish it below."}
              </span>
            )}
            <a href={explorerUrl("tx", phase.signature)} target="_blank" rel="noopener noreferrer" className="w-fit text-sm text-blue underline underline-offset-2">
              View the transaction<span className="sr-only"> (opens Solana Explorer)</span> ↗
            </a>
            {!filled && (
              <button type="button" onClick={() => setPhase({ kind: "idle" })} className="mt-2 min-h-12 cursor-pointer border border-ink text-[15px] font-semibold hover:bg-paper">
                {phase.side === "buy" ? "Buy more" : "Sell more"}
              </button>
            )}
          </div>
        ) : filled ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="kicker text-green">Sale filled</span>
            <span className="font-serif text-3xl leading-tight">The raise is complete.</span>
            <span className="text-sm leading-relaxed text-ink2">Trading on the curve has closed. Graduate the sale below to move it to its permanent pool and open the bridge.</span>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <label htmlFor={inputId} className="text-sm font-semibold">You pay</label>
                {bal && <span className="font-mono text-xs text-mute">Balance {fmtIn(have ?? 0n)} {inSymbol}</span>}
              </div>
              <div className={`flex h-16 items-center border bg-white px-4 ${touched && !parsed.ok && text ? "border-error" : "border-ink"}`}>
                <input
                  id={inputId}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0"
                  value={text}
                  disabled={busy}
                  onChange={(e) => { setText(e.target.value.slice(0, 32)); setTouched(true); if (phase.kind === "failed") setPhase({ kind: "idle" }); }}
                  aria-invalid={touched && !parsed.ok && text !== ""}
                  aria-describedby={`${inputId}-hint`}
                  className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-line num"
                />
                <span className="font-mono text-sm">{inSymbol}</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {side === "buy"
                  ? quickBuy.map((v) => (
                      <button key={v.toString()} type="button" disabled={busy} onClick={() => setAmount(v)} className="min-h-10 cursor-pointer border border-line text-sm hover:border-ink">
                        {formatUnits(v, q.decimals)}
                      </button>
                    ))
                  : [25n, 50n, 75n].map((pct) => (
                      <button key={pct.toString()} type="button" disabled={busy || !bal?.wrapper} onClick={() => setAmount(((bal?.wrapper ?? 0n) * pct) / 100n)} className="min-h-10 cursor-pointer border border-line text-sm hover:border-ink disabled:cursor-not-allowed disabled:opacity-40">
                        {pct.toString()}%
                      </button>
                    ))}
                <button
                  type="button"
                  disabled={busy || !bal}
                  onClick={() => setAmount(side === "buy" ? (bal!.quote < remaining ? bal!.quote : remaining) : bal!.wrapper)}
                  className="min-h-10 cursor-pointer border border-line text-sm hover:border-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Max
                </button>
              </div>
              <p id={`${inputId}-hint`} className={`min-h-5 text-[13px] ${touched && blocker ? "text-error" : "text-mute"}`} aria-live="polite">
                {touched && blocker ? blocker : side === "buy" ? `${formatUnits(remaining, q.decimals, { maxFraction: 0 })} ${q.symbol} left before this sale fills.` : ""}
              </p>
            </div>

            {preview && (
              <div className="flex flex-col gap-1 border-t border-rule pt-4">
                <div className="flex items-baseline justify-between bg-paper px-3 py-3">
                  <span className="text-sm text-ink2">You receive about</span>
                  <span className="font-serif text-2xl num">{fmtOut(preview.out)} <span className="font-mono text-xs text-mute">{outSymbol}</span></span>
                </div>
                <Line label="Average price, fee included">{fmtPrice(side === "buy" ? (preview.spend * 10n ** BigInt(launch.decimals)) / (preview.out || 1n) : (preview.out * 10n ** BigInt(launch.decimals)) / (preview.spend || 1n))}</Line>
                <Line label="Price moves">{fmtPrice(priceNow)} → {fmtPrice(sqrtPriceToQuoteAtoms(preview.nextSqrt, launch.decimals))}</Line>
                <Line label="Fee">{formatUnits(preview.fee, q.decimals, { maxFraction: 4 })} {q.symbol}</Line>
                <Line label="Guaranteed minimum" strong>{fmtOut(minimumOut)} {outSymbol}</Line>
                {preview.fillsSale && (
                  <p className="mt-2 border-l-2 border-blue pl-3 text-[13px] leading-relaxed text-ink2">
                    This purchase completes the sale{signAllTransactions ? ` and opens the bridge in the same approval (about ${formatUnits(GRADUATION_DEPOSIT_LAMPORTS, 9, { maxFraction: 3 })} SOL in deposits)` : ""}.
                    {preview.refunds && ` Only ${formatUnits(preview.spend, q.decimals, { maxFraction: 2 })} ${q.symbol} is needed; the rest stays in your wallet.`}
                  </p>
                )}
                <div className="mt-2 flex items-center justify-between gap-2 text-[13px] text-mute">
                  <span id={`${inputId}-slip`}>Accept price movement up to</span>
                  <div role="radiogroup" aria-labelledby={`${inputId}-slip`} className="flex gap-1">
                    {SLIPPAGES.map((bps) => (
                      <button
                        key={bps}
                        type="button"
                        role="radio"
                        aria-checked={slippage === bps}
                        disabled={busy}
                        onClick={() => setSlippage(bps)}
                        className={`min-h-9 min-w-12 cursor-pointer px-2 font-mono ${slippage === bps ? "bg-ink text-paper" : "border border-line text-ink hover:border-ink"}`}
                      >
                        {bps / 100}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {phase.kind === "failed" && (
              <div role="alert" className="flex flex-col gap-1 border border-error bg-surface p-3">
                <strong className="text-sm text-error">{phase.error.title}</strong>
                <span className="text-[13px] leading-relaxed text-ink2">{phase.error.detail}</span>
              </div>
            )}

            {!publicKey ? (
              <button type="button" onClick={openConnect} className="min-h-14 cursor-pointer bg-ink text-base font-semibold text-paper hover:bg-ink2">
                Connect a wallet to {side}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || Boolean(blocker) || !preview || !accounts.data}
                aria-describedby={`${inputId}-status`}
                className="min-h-14 cursor-pointer bg-blue text-base font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40"
              >
                {busy ? STEP_TEXT[phase.step] : preview && !blocker ? `${side === "buy" ? "Buy" : "Sell"} ${fmtOut(side === "buy" ? preview.out : preview.spend)} ${wrapper}` : side === "buy" ? "Buy" : "Sell"}
              </button>
            )}
            <p id={`${inputId}-status`} className="sr-only" aria-live="assertive">{busy ? STEP_TEXT[phase.step] : ""}</p>
            {accounts.isError && <p className="text-[13px] text-error">This sale’s trading accounts couldn’t be read. {explainTradeError(accounts.error).detail}</p>}
          </>
        )}
      </div>
    </section>
  );
}
