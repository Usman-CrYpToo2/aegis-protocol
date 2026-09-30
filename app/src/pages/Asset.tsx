import { useEffect, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { isSet, type LaunchStage } from "../chain/aegis";
import { AssetNotFoundError } from "../chain/asset";
import { METEORA_PROTOCOL_FEE_PCT, type DbcConfig } from "../chain/meteora";
import { ProgramNotDeployedError, type RegistryEntry } from "../chain/registry";
import { CurveChart } from "../components/asset/CurveChart";
import { Seal } from "../components/asset/Seal";
import { useAsset } from "../hooks/useAsset";
import { formatUnits, percentOf, shortAddress, sqrtPriceToQuoteAtoms } from "../lib/amount";
import { ARCHETYPE_CEILING, ceilingPrice } from "../lib/curve";

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

const ORDER: LaunchStage[] = ["TokenCreated", "Funded", "Configured", "Live", "Graduated"];
const MONTH = 30 * 24 * 60 * 60;

function Addr({ value, label }: { value: string; label?: string }) {
  return (
    <a href={explorerUrl("address", value)} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] text-ink2 underline decoration-line underline-offset-2 hover:text-ink">
      {label ?? shortAddress(value)}
      <span className="sr-only"> (opens Solana Explorer)</span>
    </a>
  );
}

function Leader({ label, children, strong = false }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 text-[15px] leading-relaxed ${strong ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="flex-1 -translate-y-1 border-b border-dotted border-[#A89F8A]" aria-hidden="true" />
      <span className="font-mono num text-right">{children}</span>
    </div>
  );
}

function Section({ id, title, aside, children }: { id?: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-h` : undefined} className="flex flex-col gap-6 border-t border-rule pt-10">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-baseline lg:justify-between">
        <h2 id={id ? `${id}-h` : undefined} className="font-serif text-4xl">{title}</h2>
        {aside && <span className="text-[15px] text-mute">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Stage rail
// ------------------------------------------------------------------------------------------------

const RAIL = [
  { stage: "TokenCreated", title: "Filed", text: "Security created; the issuer holds its legal powers" },
  { stage: "Funded", title: "Escrowed", text: "The whole issue locked in the Aegis vault" },
  { stage: "Configured", title: "Terms set", text: "Price, raise and liquidity rules fixed" },
  { stage: "Live", title: "Offering open", text: "Anyone can buy or sell on the curve" },
  { stage: "Graduated", title: "Graduated", text: "Moves to a permanent pool; the bridge opens" },
] as const;

function StageRail({ entry }: { entry: RegistryEntry }) {
  const current = ORDER.indexOf(entry.launch.stage);
  const pct = entry.raise ? percentOf(entry.raise.raised, entry.raise.target) : null;
  return (
    <ol aria-label="Launch stages" className="grid grid-cols-1 gap-4 border-t border-ink sm:grid-cols-5 sm:gap-0">
      {RAIL.map((step, i) => {
        const state = i < current ? "done" : i === current ? "now" : "next";
        const text = step.stage === "Live" && state === "now" && pct !== null ? `${pct}% of the raise filled · anyone can buy or sell` : step.text;
        return (
          <li
            key={step.stage}
            aria-current={state === "now" ? "step" : undefined}
            className={`flex flex-col gap-1 pt-4 sm:pr-4 ${state === "now" ? "-mt-px border-t-4 border-blue pt-3" : ""} ${state === "next" ? "text-mute" : ""}`}
          >
            <span className={`font-mono text-xs ${state === "now" ? "text-blue" : "text-mute"}`}>
              0{i + 1} · {state === "done" ? "done" : state}
            </span>
            <span className="font-semibold text-ink">{step.title}</span>
            <span className={`text-sm ${state === "now" ? "text-ink2" : "text-mute"}`}>{text}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------------------------------------
// §1 The offering
// ------------------------------------------------------------------------------------------------

function Offering({ entry, terms }: { entry: RegistryEntry; terms: DbcConfig }) {
  const { launch, quote, raise } = entry;
  const cap = ARCHETYPE_CEILING[launch.archetype];
  const d = launch.decimals;
  const ceiling = ceilingPrice(terms.sqrtStartPrice, cap.sqrtBps, d);
  const wrapper = entry.wrapperLabel?.symbol ?? "the wrapper";
  if (!quote) return null;

  const fmtQ = (v: bigint, frac = 0) => formatUnits(v, quote.decimals, { maxFraction: frac });
  const priceNow = entry.price;
  const live = launch.stage === "Live" && entry.detail.pool;
  const pct = raise ? percentOf(raise.raised, raise.target) : 0;

  return (
    <Section id="offering" title="§1 The offering" aside="Meteora dynamic bonding curve">
      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col gap-5 border border-line bg-surface p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="kicker">{live ? `Price of one ${wrapper} now` : launch.stage === "Graduated" ? "Final sale price" : "Opening price"}</span>
              <span className="font-serif text-5xl num">
                {formatUnits(priceNow ?? (launch.stage === "Graduated" ? ceilingPriceAtEnd(terms, d) : startPrice(terms, d)), quote.decimals, { maxFraction: 4, minFraction: 3 })}{" "}
                <span className="font-sans text-xl text-mute">{quote.symbol}</span>
              </span>
            </div>
          </div>
          <CurveChart
            terms={terms}
            sqrtNow={live ? entry.detail.pool!.sqrtPrice : launch.stage === "Graduated" ? terms.migrationSqrtPrice : null}
            finished={launch.stage === "Graduated"}
            ceiling={ceiling}
            ceilingLabel={cap.label}
            baseDecimals={d}
            quote={quote}
            wrapperSymbol={wrapper}
          />
          {raise && (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-[15px]">
                <span>
                  <strong className="num">{fmtQ(raise.raised)}</strong> of {fmtQ(raise.target)} {quote.symbol} raised
                </span>
                <span className="font-mono num">{pct}%</span>
              </div>
              <span role="progressbar" aria-label="Raise" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="block h-1.5 bg-track">
                <span className="block h-1.5 bg-ink" style={{ width: `${pct}%` }} />
              </span>
            </div>
          )}
          <p className="text-sm leading-relaxed text-ink2">
            {launch.stage === "Graduated"
              ? `The raise completed and the offering moved to a permanent Meteora pool at the curve's final price.`
              : `When the raise reaches ${fmtQ(terms.migrationQuoteThreshold)} ${quote.symbol}, the sale closes by itself and moves to a permanent trading pool at ${formatUnits(ceilingPriceAtEnd(terms, d), quote.decimals, { maxFraction: 4 })} — exactly where the curve ends, so the price does not jump.`}
          </p>
        </div>

        <aside aria-label="Sale terms" className="flex h-fit flex-col gap-4 border border-ink bg-surface p-5 sm:p-6">
          <h3 className="kicker">Sale terms · fixed on-chain</h3>
          <div className="flex flex-col gap-1">
            <Leader label="Opening price">{formatUnits(startPrice(terms, d), quote.decimals, { maxFraction: 4, minFraction: 3 })}</Leader>
            <Leader label="Price at graduation">{formatUnits(ceilingPriceAtEnd(terms, d), quote.decimals, { maxFraction: 4, minFraction: 3 })}</Leader>
            <Leader label="Ceiling">{cap.multiple} · {cap.label}</Leader>
            <Leader label="Raise target">{fmtQ(terms.migrationQuoteThreshold)} {quote.symbol}</Leader>
            <Leader label="Fee per trade">{(terms.curveFeeBps / 100).toFixed(2)}%</Leader>
            <Leader label="Supply, fixed">{formatUnits(launch.totalSupply, d, { maxFraction: 0 })}</Leader>
          </div>
          <p className="border-t border-rule pt-4 text-sm leading-relaxed text-ink2">
            {launch.stage === "Graduated"
              ? `The bridge is open. ${wrapper} trades freely on Meteora, and any holder the issuer has approved can exchange it one-for-one for the security.`
              : `No KYC is needed to buy or hold ${wrapper}. To exchange it for the security itself after graduation, the issuer must approve your wallet.`}
          </p>
        </aside>
      </div>
    </Section>
  );
}

const startPrice = (t: DbcConfig, d: number) => sqrtPriceToQuoteAtoms(t.sqrtStartPrice, d);
const ceilingPriceAtEnd = (t: DbcConfig, d: number) => sqrtPriceToQuoteAtoms(t.migrationSqrtPrice, d);

// ------------------------------------------------------------------------------------------------
// §2 Proof
// ------------------------------------------------------------------------------------------------

function Proof({ entry }: { entry: RegistryEntry }) {
  const { launch, backing, detail } = entry;
  const d = launch.decimals;
  const sym = entry.label?.symbol ?? "units";
  const wsym = entry.wrapperLabel?.symbol ?? "wrappers";
  const fmt = (v: bigint | undefined) => (v === undefined ? "couldn’t read" : formatUnits(v, d, { maxFraction: d }));

  const verdict =
    backing.kind === "backed"
      ? { tone: "text-green", text: `Every ${wsym} in circulation is backed by a ${sym} in escrow.` }
      : backing.kind === "escrowed"
        ? { tone: "text-green", text: `The whole issue is in escrow. Wrappers are created against it when the sale opens.` }
        : backing.kind === "short"
          ? { tone: "text-error", text: `The escrow holds less than it should. The bridge refuses to move tokens until this is fixed, so nobody is paid ahead of anyone else. This can only happen through the issuer's legal powers over the security.` }
          : backing.kind === "unknown"
            ? { tone: "text-amber", text: `This check could not be completed: ${backing.reason}. It will retry automatically.` }
            : backing.kind === "not-funded"
              ? { tone: "text-mute", text: "Nothing has been escrowed yet. No wrappers exist." }
              : { tone: "text-mute", text: "The launch was withdrawn before the sale and the asset returned to the issuer." };

  return (
    <Section id="proof" title="§2 What backs every token" aside="Read from the chain, not from us">
      <div className="grid grid-cols-1 border-y border-ink md:grid-cols-3">
        <div className="flex flex-col gap-2 py-6 md:pr-6">
          <span className="kicker">Held in escrow · {sym}</span>
          <span className="font-serif text-4xl num">{fmt(detail.escrowed)}</span>
          {isSet(launch.escrowVault) && <Addr value={launch.escrowVault.toBase58()} label={`Vault ${shortAddress(launch.escrowVault.toBase58())}`} />}
        </div>
        <div className="flex flex-col gap-2 border-t border-rule py-6 md:border-t-0 md:border-l md:px-6">
          <span className="kicker">In circulation · {wsym}</span>
          <span className="font-serif text-4xl num">{detail.circulating === undefined ? "—" : fmt(detail.circulating)}</span>
          {launch.stage === "Live" && detail.pool && detail.circulating !== undefined && detail.circulating >= detail.pool.baseReserve && (
            <span className="text-[13px] text-ink2">
              {formatUnits(detail.circulating - detail.pool.baseReserve, d, { maxFraction: 0 })} held by buyers · {formatUnits(detail.pool.baseReserve, d, { maxFraction: 0 })} still in the sale
            </span>
          )}
          {detail.circulating !== undefined && <Addr value={launch.crwaMint.toBase58()} label={`Mint ${shortAddress(launch.crwaMint.toBase58())}`} />}
        </div>
        <div className="flex flex-col gap-2 border-t border-rule py-6 md:border-t-0 md:border-l md:pl-6">
          <span className="kicker">Owed to the issuer · unsold</span>
          <span className="font-serif text-4xl num">{formatUnits(launch.issuerUnsold, d, { maxFraction: d })}</span>
          <span className="text-[13px] text-mute">Paid only from what is above everyone else’s backing</span>
        </div>
      </div>
      <p className={`flex max-w-3xl gap-3 text-[15px] leading-relaxed ${verdict.tone}`}>
        <span aria-hidden="true">{backing.kind === "backed" || backing.kind === "escrowed" ? "✓" : backing.kind === "short" || backing.kind === "unknown" ? "!" : "·"}</span>
        <span>{verdict.text}</span>
      </p>
      <p className="max-w-3xl text-sm leading-relaxed text-mute">
        Every Aegis instruction that moves either token ends by checking that the escrow still covers the wrappers in existence; if not, the transaction fails. This page re-reads both numbers every few seconds.
      </p>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------
// §3 Money
// ------------------------------------------------------------------------------------------------

function Money({ entry, terms }: { entry: RegistryEntry; terms: DbcConfig }) {
  const quote = entry.quote;
  if (!quote) return null;
  const target = terms.migrationQuoteThreshold;
  const fmt = (v: bigint) => formatUnits(v, quote.decimals, { maxFraction: 0 });
  const payout = (target * BigInt(terms.migrationFeePct)) / 100n;
  const toIssuer = (payout * BigInt(terms.creatorMigrationFeePct)) / 100n;
  const toAegis = payout - toIssuer;
  const toPool = target - payout;

  const vest = terms.creatorVesting;
  const months = vest ? Math.round((vest.periods * vest.frequency) / MONTH) : 0;
  const nonMeteora = 100 - METEORA_PROTOCOL_FEE_PCT;
  const fee = terms.curveFeeBps / 100;
  const issuerFee = (fee * nonMeteora * terms.creatorTradingFeePct) / 10_000;
  const aegisFee = (fee * nonMeteora) / 100 - issuerFee;
  const meteoraFee = (fee * METEORA_PROTOCOL_FEE_PCT) / 100;
  const pctFmt = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}%`;

  return (
    <Section id="money" title={`§3 Where the ${fmt(target)} ${quote.symbol} goes`} aside="Set before the sale opened. Nobody can change it now.">
      <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
        <div className="flex items-baseline justify-between gap-4 bg-ink px-5 py-4 text-paper">
          <span className="font-semibold">Paid out at graduation</span>
          <span className="font-mono whitespace-nowrap num">{fmt(payout)} · {terms.migrationFeePct}%</span>
        </div>
        <div className="flex items-baseline justify-between gap-4 bg-blue px-5 py-4 text-white">
          <span className="font-semibold">Becomes the permanent pool</span>
          <span className="font-mono whitespace-nowrap num">{fmt(toPool)} · {100 - terms.migrationFeePct}%</span>
        </div>
        <div className="flex flex-col gap-1 px-1 py-3 text-sm text-ink2">
          <span>To the issuer: <strong className="num">{fmt(toIssuer)} {quote.symbol}</strong>, the capital this offering raises.</span>
          {toAegis > 0n && <span>To Aegis: <strong className="num">{fmt(toAegis)} {quote.symbol}</strong>.</span>}
        </div>
        <div className="grid grid-cols-1 gap-1 py-1 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5 border border-blue p-3">
            <span className="font-mono text-sm num">{terms.partnerPermanentPct}%</span>
            <span className="text-xs text-ink2">Aegis · locked forever</span>
          </div>
          <div className="flex flex-col gap-0.5 border border-blue p-3">
            <span className="font-mono text-sm num">{terms.creatorPermanentPct}%</span>
            <span className="text-xs text-ink2">Issuer · locked forever</span>
          </div>
          {vest && (
            <div className="flex flex-col gap-0.5 border border-dashed border-blue p-3">
              <span className="font-mono text-sm num">{vest.percentage}%</span>
              <span className="text-xs text-ink2">Issuer · unlocks over {months} months</span>
            </div>
          )}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-mute">
        Nobody can withdraw pool liquidity on day one. Each trade on the curve pays {pctFmt(fee)}: {pctFmt(aegisFee)} to Aegis, {pctFmt(meteoraFee)} to Meteora
        {issuerFee > 0 ? `, ${pctFmt(issuerFee)} to the issuer` : ""}. Trades in the permanent pool pay {pctFmt(terms.migratedPoolFeeBps / 100)}.
      </p>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------
// §4 Guarantees
// ------------------------------------------------------------------------------------------------

function Guarantees({ entry }: { entry: RegistryEntry }) {
  const cap = ARCHETYPE_CEILING[entry.launch.archetype];
  const supply = formatUnits(entry.launch.totalSupply, entry.launch.decimals, { maxFraction: 0 });
  const configured = ORDER.indexOf(entry.launch.stage) >= ORDER.indexOf("Configured");
  const wrapper = entry.wrapperLabel?.symbol ?? "wrapper";
  return (
    <Section id="guarantees" title="§4 What is guaranteed, and by whom">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Enforced by code — nobody can change these</h3>
          <ul className="flex flex-col gap-2.5 text-[15px] leading-relaxed">
            <li className="flex gap-2.5"><span className="font-mono text-green">✓</span>Supply is fixed at {supply}. No new {wrapper} can be printed.</li>
            <li className="flex gap-2.5"><span className="font-mono text-green">✓</span>Every {wrapper} is backed by one unit of the security held in escrow.</li>
            {configured && <li className="flex gap-2.5"><span className="font-mono text-green">✓</span>The sale price can never pass the {cap.multiple} ceiling.</li>}
            <li className="flex gap-2.5"><span className="font-mono text-green">✓</span>The bridge opens at graduation even if the issuer does nothing.</li>
          </ul>
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Held by the issuer — required by securities law</h3>
          <ul className="flex flex-col gap-2.5 text-[15px] leading-relaxed">
            <li className="flex gap-2.5"><span className="font-mono text-amber">§</span>Decides who is approved to hold the security (KYC).</li>
            <li className="flex gap-2.5"><span className="font-mono text-amber">§</span>Can freeze a holder or pause all transfers of the security.</li>
            <li className="flex gap-2.5"><span className="font-mono text-amber">§</span>Can move the security under a court order — this includes the escrow.</li>
            <li className="flex gap-2.5"><span className="font-mono text-amber">§</span>If the escrow ever falls short, §2 above shows it within seconds.</li>
          </ul>
        </div>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

function Crumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="font-mono text-[13px] text-mute">
      <Link to="/" className="underline decoration-line underline-offset-2 hover:text-ink">Registry</Link> / <span aria-current="page">{name}</span>
    </nav>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="shell flex flex-col gap-4 py-20">
      <Crumb name="Not found" />
      <h1 className="font-serif text-5xl sm:text-6xl">{title}</h1>
      <div className="max-w-2xl text-lg leading-relaxed text-ink2">{children}</div>
      <Link to="/" className="mt-2 inline-flex min-h-12 w-fit items-center bg-blue px-5 font-semibold text-white hover:bg-blue-deep">Back to the registry</Link>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="shell flex flex-col gap-8 pt-10 pb-24" aria-busy="true" aria-label="Loading the asset">
      <span className="h-4 w-40 animate-pulse bg-track" />
      <span className="h-20 w-2/3 animate-pulse bg-track" />
      <span className="h-5 w-1/2 animate-pulse bg-track/70" />
      <span className="mt-6 h-72 w-full animate-pulse bg-track/60" />
    </div>
  );
}

export function AssetPage() {
  const { mint } = useParams();
  const asset = useAsset(mint);
  const entry = asset.data;

  useEffect(() => {
    document.title = entry?.label?.name ? `${entry.label.name} — Aegis` : "Aegis";
    return () => {
      document.title = "Aegis — The Registry";
    };
  }, [entry?.label?.name]);

  if (!entry) {
    if (asset.isPending) return <Skeleton />;
    if (asset.error instanceof AssetNotFoundError) {
      return (
        <Message title="Not in the registry">
          {asset.error.reason === "invalid-address"
            ? "That link doesn’t contain a valid asset address. It may have been cut off when it was copied."
            : "No asset has been filed with Aegis under this address. It may be on another network — this app reads " + config.cluster + "."}
        </Message>
      );
    }
    if (asset.error instanceof ProgramNotDeployedError) {
      return <Message title={`Aegis isn’t on ${config.cluster} yet`}>The program was not found on this network, so there is nothing to show.</Message>;
    }
    return (
      <Message title="Can’t reach the network">
        <p>This page reads the asset straight from the chain at <span className="font-mono text-base">{config.rpcUrl}</span>, and that node isn’t answering.</p>
        <button type="button" onClick={() => void asset.refetch()} className="mt-4 inline-flex min-h-11 cursor-pointer items-center bg-ink px-5 text-sm font-semibold text-paper hover:bg-ink2">
          Try again
        </button>
      </Message>
    );
  }

  const { launch, label, wrapperLabel, detail } = entry;
  const name = label?.name || "Unnamed asset";
  const sym = label?.symbol;
  const wsym = wrapperLabel?.symbol;
  const cap = ARCHETYPE_CEILING[launch.archetype];
  const configured = ORDER.indexOf(launch.stage) >= ORDER.indexOf("Configured") && launch.stage !== "Aborted";
  const supply = formatUnits(launch.totalSupply, launch.decimals, { maxFraction: 0 });

  return (
    <div className="shell flex flex-col gap-12 pt-8 pb-24 lg:pt-10">
      {asset.isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-amber bg-amber-wash px-4 py-3 text-sm">
          <span>Couldn’t refresh from the network. The numbers below may be out of date.</span>
          <button type="button" onClick={() => void asset.refetch()} className="min-h-11 cursor-pointer font-semibold underline underline-offset-4">Try again</button>
        </div>
      )}
      {launch.stage === "Aborted" && (
        <div role="status" className="border border-line bg-surface px-4 py-3 text-[15px]">This launch was withdrawn before its sale opened. The asset went back to the issuer, and no wrappers exist.</div>
      )}

      <section className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-5">
          <Crumb name={name} />
          <span className="kicker">Registered security · {supply} units</span>
          <h1 className="font-serif text-6xl leading-[0.95] sm:text-7xl xl:text-[104px]">{name}</h1>
          <p className="max-w-3xl text-lg leading-relaxed text-ink2 lg:text-[19px]">
            A registered security of {supply} units.
            {wsym ? (
              <> It trades freely as <strong className="text-ink">{wsym}</strong>. Any approved holder can exchange it one-for-one for the security itself{sym ? <>, <strong className="text-ink">{sym}</strong>,</> : ""} after graduation.</>
            ) : (
              <> Its tradable wrapper is created when the sale opens.</>
            )}
          </p>
          <div className="flex flex-wrap gap-2 text-[13px] text-ink2">
            {sym && <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5"><strong className="font-mono font-medium">{sym}</strong> the security · holders must be approved</span>}
            {wsym && <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5"><strong className="font-mono font-medium">{wsym}</strong> the wrapper · anyone can hold</span>}
            {configured && <span className="inline-flex h-7 items-center rounded-full border border-line bg-surface px-2.5">{cap.label} · price may rise up to {cap.multiple}</span>}
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5">Issuer <Addr value={launch.issuer.toBase58()} /></span>
          </div>
        </div>
        <figure className="m-0 flex flex-col items-center gap-3 justify-self-center lg:justify-self-end">
          <Seal backing={entry.backing} decimals={launch.decimals} id="seal-ring" />
          <figcaption className="font-mono text-xs text-mute">
            Checked {Math.max(0, Math.round((Date.now() - entry.readAt) / 1000))}s ago · <a href="#proof" className="underline underline-offset-2 hover:text-ink">see the proof</a>
          </figcaption>
        </figure>
      </section>

      {launch.stage !== "Aborted" && <StageRail entry={entry} />}

      {configured && detail.terms ? (
        <Offering entry={entry} terms={detail.terms} />
      ) : launch.stage !== "Aborted" ? (
        <Section id="offering" title="§1 The offering">
          <p className="max-w-2xl text-[15px] leading-relaxed text-ink2">
            {configured ? "The sale terms couldn’t be read right now. They will appear here on the next refresh." : "The issuer hasn’t set the sale terms yet. Price, raise and liquidity rules appear here once they are fixed on-chain, before anyone can buy."}
          </p>
        </Section>
      ) : null}

      <Proof entry={entry} />
      {configured && detail.terms && <Money entry={entry} terms={detail.terms} />}
      <Guarantees entry={entry} />
    </div>
  );
}
