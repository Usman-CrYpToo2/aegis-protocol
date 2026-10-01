import { useId, type ReactNode } from "react";
import type { QuoteToken } from "../../chain/platform";
import { formatUnits, parseUnits } from "../../lib/amount";
import { ARCHETYPES, MAX_SQRT_BPS, limitProblems, poolFeeRange, previewTerms, priceMultiple, type Archetype, type PlanError, type PlatformLimits, type Terms } from "../../lib/terms";
import { ISSUE_ERRORS } from "../../lib/txErrors";

export type TermsDraft = {
  quote: string;
  price: string;
  archetype: Archetype;
  sqrtBps: number;
  raise: string;
  cashPct: number;
  permanentPct: number;
  months: number;
  poolFee: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function defaultTerms(p: PlatformLimits, quote: QuoteToken): TermsDraft {
  const share = 100 - p.aegisLpSharePct;
  const permanent = clamp(30, p.minIssuerPermanentPct, share);
  const fee = poolFeeRange(p);
  const minRaise = Number(quote.minRaise) / 10 ** quote.decimals;
  return {
    quote: quote.mint.toBase58(),
    price: "1.00",
    archetype: "BookBuilding",
    sqrtBps: 11_000,
    raise: String(Math.max(10_000, Math.ceil(minRaise))),
    cashPct: clamp(50, p.minMigrationFeePct, p.maxMigrationFeePct),
    permanentPct: permanent,
    months: clamp(12, Math.max(1, p.minVestingMonths), p.maxVestingMonths),
    poolFee: (clamp(100, fee.min, fee.max) / 100).toFixed(2),
  };
}

const ARCH_COPY: Record<Archetype, { title: string; body: string }> = {
  FixedPar: { title: "Fixed par", body: "Near-fixed price" },
  BookBuilding: { title: "Book building", body: "Price found in a range" },
  GrowthCapital: { title: "Growth capital", body: "Wider discovery" },
};

export type TermsResult =
  | { ok: true; terms: Terms; quote: QuoteToken }
  | { ok: false; field: "price" | "raise" | "poolFee" | "quote"; message: string };

export function readTerms(d: TermsDraft, quotes: QuoteToken[], p: PlatformLimits): TermsResult {
  const quote = quotes.find((q) => q.mint.toBase58() === d.quote);
  if (!quote) return { ok: false, field: "quote", message: "Choose the currency buyers pay in." };
  const price = parseUnits(d.price, quote.decimals);
  if (!price.ok) return { ok: false, field: "price", message: price.reason };
  const raise = parseUnits(d.raise, quote.decimals);
  if (!raise.ok) return { ok: false, field: "raise", message: raise.reason };
  const fee = Number(d.poolFee);
  if (!/^\d+(\.\d{1,2})?$/.test(d.poolFee.trim()) || !Number.isFinite(fee)) return { ok: false, field: "poolFee", message: "Enter a percentage like 1.00" };
  const share = 100 - p.aegisLpSharePct;
  return {
    ok: true,
    quote,
    terms: {
      quoteAtomsPerToken: price.atoms,
      archetype: d.archetype,
      sqrtBps: Math.min(d.sqrtBps, MAX_SQRT_BPS[d.archetype]),
      targetRaise: raise.atoms,
      migrationFeePct: d.cashPct,
      permanentPct: d.permanentPct,
      vestedPct: share - d.permanentPct,
      vestingMonths: d.months,
      poolFeeBps: Math.round(fee * 100),
    },
  };
}

function Q({ n, title, children, hint }: { n: number; title: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 border-b border-rule py-6">
      <span className="pt-1 font-mono text-xs text-mute">{n ? `Q${n}` : "—"}</span>
      <div className="flex flex-col gap-3">
        <div className="text-[17px] font-semibold">{title}</div>
        {children}
        {hint && <div className="text-[13px] leading-relaxed text-mute">{hint}</div>}
      </div>
    </div>
  );
}

const inputCls = "min-h-12 w-full border border-line bg-surface px-3 text-[17px] outline-none focus:border-ink aria-[invalid=true]:border-error num";

export function TermsForm({ draft, onChange, quotes, platform, disabled }: { draft: TermsDraft; onChange: (d: TermsDraft) => void; quotes: QuoteToken[]; platform: PlatformLimits; disabled: boolean }) {
  const id = useId();
  const set = <K extends keyof TermsDraft>(k: K, v: TermsDraft[K]) => onChange({ ...draft, [k]: v });
  const quote = quotes.find((q) => q.mint.toBase58() === draft.quote);
  const sym = quote?.symbol ?? "";
  const result = readTerms(draft, quotes, platform);
  const err = (f: string) => (!result.ok && result.field === f && draft[f as keyof TermsDraft] !== "" ? result.message : undefined);
  const share = 100 - platform.aegisLpSharePct;
  const fee = poolFeeRange(platform);
  const vested = share - draft.permanentPct;
  const maxBps = MAX_SQRT_BPS[draft.archetype];

  return (
    <fieldset disabled={disabled} className="flex flex-col border-t border-ink">
      <legend className="sr-only">Sale terms</legend>
      {(quotes.length > 1 || !quote) && (
        <Q n={0} title="Which currency do buyers pay in?">
          <select className={inputCls} value={quote ? draft.quote : ""} onChange={(e) => set("quote", e.target.value)} aria-label="Currency">
            {!quote && <option value="" disabled>Choose a currency</option>}
            {quotes.map((q) => <option key={q.mint.toBase58()} value={q.mint.toBase58()}>{q.symbol}</option>)}
          </select>
        </Q>
      )}
      <Q n={1} title={<label htmlFor={`${id}-price`}>At what price should the sale open?</label>} hint={err("price") ? <span role="alert" className="text-error">{err("price")}</span> : "What the first buyer pays for one token."}>
        <div className="flex max-w-sm items-center gap-2">
          <input id={`${id}-price`} className={inputCls} inputMode="decimal" value={draft.price} onChange={(e) => set("price", e.target.value)} aria-invalid={Boolean(err("price"))} />
          <span className="shrink-0 font-mono text-sm text-mute">{sym} per token</span>
        </div>
      </Q>
      <Q n={2} title="How far may the price rise during the sale?" hint={<>Price at the end of the sale: <strong className="text-ink">{priceMultiple(Math.min(draft.sqrtBps, maxBps)).toFixed(2)}×</strong> the opening price.</>}>
        <div role="radiogroup" aria-label="Sale type" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {ARCHETYPES.map((a) => {
            const on = draft.archetype === a;
            return (
              <button key={a} type="button" role="radio" aria-checked={on} onClick={() => onChange({ ...draft, archetype: a, sqrtBps: MAX_SQRT_BPS[a] })}
                className={`flex cursor-pointer flex-col items-start gap-0.5 border px-3 py-3 text-left ${on ? "border-ink bg-surface" : "border-line hover:border-ink"}`}>
                <span className="text-sm font-semibold">{ARCH_COPY[a].title} <span className="font-mono text-xs font-normal text-mute">up to {priceMultiple(MAX_SQRT_BPS[a]).toFixed(2)}×</span></span>
                <span className="text-[13px] text-mute">{ARCH_COPY[a].body}</span>
              </button>
            );
          })}
        </div>
        <input type="range" min={10_001} max={maxBps} step={1} value={Math.min(draft.sqrtBps, maxBps)} onChange={(e) => set("sqrtBps", Number(e.target.value))} aria-label="End price multiple" className="w-full accent-blue" />
      </Q>
      <Q n={3} title={<label htmlFor={`${id}-raise`}>How much do you want to raise?</label>} hint={err("raise") ? <span role="alert" className="text-error">{err("raise")}</span> : <>The sale closes by itself when this amount is reached.{quote && quote.minRaise > 0n && <> Minimum for {sym}: {formatUnits(quote.minRaise, quote.decimals, { maxFraction: 2 })}.</>}</>}>
        <div className="flex max-w-sm items-center gap-2">
          <input id={`${id}-raise`} className={inputCls} inputMode="decimal" value={draft.raise} onChange={(e) => set("raise", e.target.value)} aria-invalid={Boolean(err("raise"))} />
          <span className="shrink-0 font-mono text-sm text-mute">{sym}</span>
        </div>
      </Q>
      <Q n={4} title={<>How much of the raise do you take as cash? <span className="font-serif text-2xl font-normal num">{draft.cashPct}%</span></>} hint="The rest becomes the trading pool. More cash for you means a thinner market for your holders.">
        <input type="range" min={platform.minMigrationFeePct} max={platform.maxMigrationFeePct} value={draft.cashPct} onChange={(e) => set("cashPct", Number(e.target.value))} aria-label="Cash share of the raise" className="w-full accent-blue" />
        <div className="flex justify-between font-mono text-xs text-mute"><span>{platform.minMigrationFeePct}% · deep market</span><span>{platform.maxMigrationFeePct}% · most cash</span></div>
        {platform.aegisMigrationFeeSharePct > 0 && <span className="text-[13px] text-mute">Aegis keeps {platform.aegisMigrationFeeSharePct}% of this cash as its fee.</span>}
      </Q>
      <Q n={5} title={`Your ${share}% of the pool: how is it locked?`} hint={`Aegis keeps the other ${platform.aegisLpSharePct}%, locked forever, so a market always exists. None of it can be withdrawn on day one.`}>
        <div className="flex items-center gap-4">
          <span className="w-40 shrink-0 text-sm">Locked forever <strong className="num">{draft.permanentPct}%</strong></span>
          <input type="range" min={platform.minIssuerPermanentPct} max={share} value={draft.permanentPct} onChange={(e) => set("permanentPct", Number(e.target.value))} aria-label="Share locked forever" className="w-full accent-blue" />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>Unlocks monthly <strong className="num">{vested}%</strong></span>
          {vested > 0 && (
            <label className="flex items-center gap-2">
              over
              <select value={draft.months} onChange={(e) => set("months", Number(e.target.value))} className="min-h-10 border border-line bg-surface px-2">
                {Array.from({ length: platform.maxVestingMonths - Math.max(1, platform.minVestingMonths) + 1 }, (_, i) => Math.max(1, platform.minVestingMonths) + i).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              months
            </label>
          )}
        </div>
      </Q>
      <Q n={6} title={<label htmlFor={`${id}-fee`}>Trading fee in the pool after graduation</label>} hint={err("poolFee") ? <span role="alert" className="text-error">{err("poolFee")}</span> : "Keep it low: a high fee lets the market price drift further from the asset’s value."}>
        <div className="flex max-w-sm items-center gap-2">
          <input id={`${id}-fee`} className={inputCls} inputMode="decimal" value={draft.poolFee} onChange={(e) => set("poolFee", e.target.value)} aria-invalid={Boolean(err("poolFee"))} />
          <span className="shrink-0 font-mono text-sm text-mute">% · between {(fee.min / 100).toFixed(2)} and {(fee.max / 100).toFixed(2)}</span>
        </div>
      </Q>
    </fieldset>
  );
}

function planMessage(e: PlanError) {
  return ISSUE_ERRORS[e] ?? { title: "These terms don’t work", detail: "Adjust the price or the raise." };
}

/** "What these terms mean": recalculated as the issuer types, with the program's own maths. */
export function TermsPreview({ result, platform, totalSupply, decimals, symbol, curveFeeBps, issuerCurveFeeSharePct }: {
  result: TermsResult; platform: PlatformLimits; totalSupply: bigint; decimals: number; symbol: string; curveFeeBps: number; issuerCurveFeeSharePct: number;
}) {
  const row = (k: string, v: ReactNode) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-track py-2.5 text-sm"><span className="text-ink2">{k}</span><span className="text-right num">{v}</span></div>
  );
  if (!result.ok) return <p className="py-4 text-sm text-mute">Fill in the answers to see what they mean.</p>;
  const { terms, quote } = result;
  const problems = limitProblems(terms, platform, quote.minRaise);
  const pv = previewTerms(terms, platform, totalSupply, decimals);
  // A preview rounds to the nearest shown digit; balances elsewhere truncate.
  const round = (v: bigint, dec: number, f: number) => (f >= dec ? v : v + (5n * 10n ** BigInt(dec - f - 1)));
  const q = (v: bigint, f = 0) => `${formatUnits(round(v, quote.decimals, f), quote.decimals, { maxFraction: f, minFraction: f })} ${quote.symbol}`;
  const t = (v: bigint) => formatUnits(round(v, decimals, 0), decimals, { maxFraction: 0 });
  const price = (v: bigint) => formatUnits(round(v, quote.decimals, 4), quote.decimals, { maxFraction: 4, minFraction: 2 });
  const rise = Math.round((priceMultiple(terms.sqrtBps) - 1) * 100);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between border-b border-ink pb-3">
        <span className="flex flex-col"><span className="font-mono text-xs text-mute">OPENS AT</span><span className="font-serif text-3xl num">{price(terms.quoteAtomsPerToken)}</span></span>
        <span aria-hidden="true" className="mb-2 h-px flex-1 bg-gradient-to-r from-line to-blue mx-4" />
        <span className="flex flex-col text-right"><span className="font-mono text-xs text-mute">CLOSES AT</span><span className="font-serif text-3xl num">{pv.ok ? price(pv.preview.endPrice) : "—"}</span></span>
      </div>
      {pv.ok ? (
        <div>
          {row("Tokens sold during the sale", `${t(pv.preview.plan.baseSold)} ${symbol}`)}
          {row("Price at graduation", q(pv.preview.endPrice, 3))}
          {row("Cash to you at graduation", q(pv.preview.cashToIssuer))}
          {row("Trading pool at launch", <>{q(pv.preview.poolQuote)} + ≈{t(pv.preview.poolBase)} {symbol}</>)}
          {row("Unsold stock returned to you", <>≈ {t(pv.preview.unsold)} {symbol}</>)}
          {row("Aegis fee", `${(curveFeeBps / 100).toFixed(2).replace(/\.?0+$/, "")}% of sale trades${issuerCurveFeeSharePct ? ` · ${issuerCurveFeeSharePct}% of it to you` : ""}`)}
        </div>
      ) : (
        <div role="alert" className="border border-error bg-surface p-4 text-sm"><strong className="text-error">{planMessage(pv.error).title}.</strong> <span className="text-ink2">{planMessage(pv.error).detail}</span></div>
      )}
      <ul className="flex flex-col gap-2 text-sm leading-relaxed">
        {pv.ok && <li className="flex gap-2"><span className="text-green">✓</span><span>Your {t(totalSupply)} supply covers this raise ({((Number(pv.preview.plan.baseSold) / Number(totalSupply)) * 100).toFixed(1)}% is sold).</span></li>}
        {problems.length === 0
          ? <li className="flex gap-2"><span className="text-green">✓</span><span>All answers are within the platform’s limits.</span></li>
          : problems.map((p) => <li key={p} className="flex gap-2"><span className="text-error">✕</span><span>{p}</span></li>)}
        {pv.ok && <li className="flex gap-2"><span className="text-green">✓</span><span>The pool opens at the sale’s final price — no jump.</span></li>}
        {rise > 0 && <li className="flex gap-2"><span className="text-amber">!</span><span>Late buyers pay up to {rise}% more than early ones. Say so in your offering documents.</span></li>}
      </ul>
    </div>
  );
}
