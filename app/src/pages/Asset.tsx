import { useEffect, useState, type ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { isSet, type LaunchStage } from "../chain/aegis";
import { AssetNotFoundError } from "../chain/asset";
import { METEORA_PROTOCOL_FEE_PCT, type DbcConfig } from "../chain/meteora";
import { ProgramNotDeployedError, type RegistryEntry } from "../chain/registry";
import { loadPaused } from "../chain/powers";
import { CurveChart } from "../components/asset/CurveChart";
import { Seal } from "../components/asset/Seal";
import { BridgeBox } from "../components/asset/BridgeBox";
import { GraduatePanel } from "../components/asset/GraduatePanel";
import { Hint } from "../components/Hint";
import { STAGE } from "../lib/stage";
import { TradePanel } from "../components/asset/TradePanel";
import { useAsset } from "../hooks/useAsset";
import { useChangeFlash } from "../hooks/useChangeFlash";
import { useNow } from "../hooks/useNow";
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

// ------------------------------------------------------------------------------------------------
// The numbers that matter, in one row
// ------------------------------------------------------------------------------------------------

const startPrice = (t: DbcConfig, d: number) => sqrtPriceToQuoteAtoms(t.sqrtStartPrice, d);
const endPrice = (t: DbcConfig, d: number) => sqrtPriceToQuoteAtoms(t.migrationSqrtPrice, d);

function Stat({ label, hint, children, sub }: { label: string; hint?: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-4 sm:px-5 sm:first:pl-0">
      <span className="flex items-center gap-1 kicker">{label}{hint && <Hint>{hint}</Hint>}</span>
      <span className="font-serif text-3xl leading-none num">{children}</span>
      {sub && <span className="text-[13px] text-mute">{sub}</span>}
    </div>
  );
}

function Stats({ entry, readAt, onProof }: { entry: RegistryEntry; readAt: number; onProof: () => void }) {
  const now = useNow();
  const flash = useChangeFlash(entry.price);
  const { launch, quote, raise, backing, detail } = entry;
  const d = launch.decimals;
  const terms = detail.terms;
  const q = (v: bigint, f = 0) => (quote ? formatUnits(v, quote.decimals, { maxFraction: f, minFraction: f }) : "—");
  const price = entry.price ?? (terms ? (launch.stage === "Graduated" ? endPrice(terms, d) : startPrice(terms, d)) : null);
  const pct = raise ? percentOf(raise.raised, raise.target) : 0;
  const wsym = entry.wrapperLabel?.symbol ?? "the wrapper";
  const sym = entry.label?.symbol ?? "the security";
  const ok = backing.kind === "backed" || backing.kind === "escrowed";
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 border-y border-ink sm:grid-cols-4 sm:divide-x sm:divide-rule">
      <Stat label={launch.stage === "Live" ? "Price" : launch.stage === "Graduated" ? "Final sale price" : "Opening price"} hint={`Price of one ${wsym} in ${quote?.symbol ?? "the quote token"}, on Meteora’s bonding curve.`}>
        <span key={flash} className={`-mx-1 px-1 ${flash}`}>{price !== null ? q(price, 4) : "—"}</span> <span className="font-sans text-sm text-mute">{quote?.symbol}</span>
      </Stat>
      <Stat label="Raised" sub={raise ? <span className="flex items-center gap-2"><span className="block h-1 w-20 bg-track"><span className="bar-fill block h-1 bg-ink" style={{ width: `${pct}%` }} /></span>{pct}% of {q(raise.target)}</span> : "Opens with the sale"}>
        {raise ? q(raise.raised) : "—"} <span className="font-sans text-sm text-mute">{quote?.symbol}</span>
      </Stat>
      <Stat label="Backing" hint={`Every ${wsym} is backed by one ${sym} in escrow. Checked from the chain every few seconds.`}
        sub={<button type="button" onClick={onProof} className="cursor-pointer underline decoration-line underline-offset-2 hover:text-ink">Checked {Math.max(0, Math.round((now - readAt) / 1000))}s ago</button>}>
        <span className={ok ? "text-green" : backing.kind === "short" ? "text-error" : "text-mute"}>{ok ? "1 : 1 ✓" : backing.kind === "short" ? "Short" : "—"}</span>
      </Stat>
      <Stat label="Supply" hint="Fixed for good. No more can ever be issued.">{formatUnits(launch.totalSupply, d, { maxFraction: 0 })}</Stat>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Details, in tabs
// ------------------------------------------------------------------------------------------------

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-3 text-[15px]">
      <span className="flex items-center gap-1 text-ink2">{label}{hint && <Hint>{hint}</Hint>}</span>
      <span className="text-right num">{children}</span>
    </div>
  );
}

function Terms({ entry, terms }: { entry: RegistryEntry; terms: DbcConfig | null }) {
  const { launch, quote } = entry;
  const d = launch.decimals;
  const cap = ARCHETYPE_CEILING[launch.archetype];
  const q = (v: bigint, f = 0) => (quote ? `${formatUnits(v, quote.decimals, { maxFraction: f, minFraction: f })} ${quote.symbol}` : "—");
  return (
    <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
      <div>
        {terms ? (
          <>
            <Row label="Opening price">{q(startPrice(terms, d), 4)}</Row>
            <Row label="Price at graduation" hint="The sale closes here and the permanent pool opens at the same price, so it doesn’t jump.">{q(endPrice(terms, d), 4)}</Row>
            <Row label="Price ceiling" hint="Set by the sale type. The curve can never pass it.">{cap.multiple} · {cap.label}</Row>
            <Row label="Raise target">{q(terms.migrationQuoteThreshold)}</Row>
            <Row label="Fee per sale trade">{(terms.curveFeeBps / 100).toFixed(2)}%</Row>
          </>
        ) : <p className="py-3 text-[15px] text-mute">The issuer hasn’t fixed the sale terms yet.</p>}
      </div>
      <div>
        <Row label="Security">{entry.label?.symbol ?? "—"} · <Addr value={launch.realRwaMint.toBase58()} /></Row>
        {isSet(launch.crwaMint) && <Row label="Wrapper" hint="Anyone can hold and trade it. No KYC.">{entry.wrapperLabel?.symbol ?? "—"} · <Addr value={launch.crwaMint.toBase58()} /></Row>}
        <Row label="Issuer" hint="Approves who may hold the security, as securities law requires.">{<Addr value={launch.issuer.toBase58()} />}</Row>
        {isSet(launch.escrowVault) && <Row label="Escrow vault">{<Addr value={launch.escrowVault.toBase58()} />}</Row>}
        {terms && <Row label="Pool fee after graduation">{(terms.migratedPoolFeeBps / 100).toFixed(2)}%</Row>}
      </div>
    </div>
  );
}

function Proof({ entry }: { entry: RegistryEntry }) {
  const { launch, backing, detail } = entry;
  const d = launch.decimals;
  const sym = entry.label?.symbol ?? "units";
  const wsym = entry.wrapperLabel?.symbol ?? "wrappers";
  const fmt = (v: bigint | undefined) => (v === undefined ? "couldn’t read" : formatUnits(v, d, { maxFraction: d }));
  const verdict =
    backing.kind === "backed" ? { tone: "text-green", text: `Every ${wsym} in circulation is backed.` }
      : backing.kind === "escrowed" ? { tone: "text-green", text: "The whole issue is in escrow." }
        : backing.kind === "short" ? { tone: "text-error", text: "The escrow holds less than it should. Exchanges are stopped for everyone until it’s fixed." }
          : backing.kind === "unknown" ? { tone: "text-amber", text: `Couldn’t check: ${backing.reason}. Retrying.` }
            : backing.kind === "not-funded" ? { tone: "text-mute", text: "Nothing is escrowed yet." }
              : { tone: "text-mute", text: "Withdrawn before the sale; the asset went back to the issuer." };
  return (
    <div className="grid grid-cols-1 items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <Row label={`Held in escrow · ${sym}`}>{fmt(detail.escrowed)}</Row>
        <Row label={`In circulation · ${wsym}`} hint={launch.stage === "Live" && detail.pool && detail.circulating !== undefined && detail.circulating >= detail.pool.baseReserve
          ? `${formatUnits(detail.circulating - detail.pool.baseReserve, d, { maxFraction: 0 })} held by buyers, ${formatUnits(detail.pool.baseReserve, d, { maxFraction: 0 })} still in the sale.` : undefined}>
          {detail.circulating === undefined ? "—" : fmt(detail.circulating)}
        </Row>
        <Row label="Owed to the issuer · unsold" hint="Paid only from what is above everyone else’s backing.">{formatUnits(launch.issuerUnsold, d, { maxFraction: d })}</Row>
        <p className={`mt-4 flex items-center gap-2 text-[15px] ${verdict.tone}`}>
          <span aria-hidden="true">{backing.kind === "backed" || backing.kind === "escrowed" ? "✓" : "!"}</span>{verdict.text}
          <Hint>Every Aegis instruction that moves either token ends by checking that the escrow still covers every wrapper. If it doesn’t, the transaction fails.</Hint>
        </p>
      </div>
      <div className="justify-self-center"><Seal backing={backing} decimals={d} id="seal-ring" /></div>
    </div>
  );
}

function Money({ entry, terms }: { entry: RegistryEntry; terms: DbcConfig }) {
  const quote = entry.quote;
  if (!quote) return null;
  const target = terms.migrationQuoteThreshold;
  const q = (v: bigint) => `${formatUnits(v, quote.decimals, { maxFraction: 0 })} ${quote.symbol}`;
  const payout = (target * BigInt(terms.migrationFeePct)) / 100n;
  const toIssuer = (payout * BigInt(terms.creatorMigrationFeePct)) / 100n;
  const vest = terms.creatorVesting;
  const months = vest ? Math.round((vest.periods * vest.frequency) / MONTH) : 0;
  const nonMeteora = 100 - METEORA_PROTOCOL_FEE_PCT;
  const fee = terms.curveFeeBps / 100;
  const issuerFee = (fee * nonMeteora * terms.creatorTradingFeePct) / 10_000;
  const pctFmt = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}%`;
  return (
    <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
      <div>
        <Row label="To the issuer at graduation" hint="The capital this offering raises.">{q(toIssuer)} · {terms.migrationFeePct}%</Row>
        {payout > toIssuer && <Row label="To Aegis">{q(payout - toIssuer)}</Row>}
        <Row label="Becomes the permanent pool">{q(target - payout)} · {100 - terms.migrationFeePct}%</Row>
      </div>
      <div>
        <Row label="Pool locked forever" hint="Nobody can ever withdraw it. It keeps a market open for good.">{terms.partnerPermanentPct + terms.creatorPermanentPct}%</Row>
        {vest && <Row label="Issuer’s share unlocking" hint="Released monthly after graduation. None of it on day one.">{vest.percentage}% over {months} months</Row>}
        <Row label="Fee per sale trade" hint={`${pctFmt((fee * METEORA_PROTOCOL_FEE_PCT) / 100)} to Meteora, ${pctFmt((fee * nonMeteora) / 100 - issuerFee)} to Aegis${issuerFee > 0 ? `, ${pctFmt(issuerFee)} to the issuer` : ""}.`}>{pctFmt(fee)}</Row>
      </div>
    </div>
  );
}

function Rules({ entry }: { entry: RegistryEntry }) {
  const cap = ARCHETYPE_CEILING[entry.launch.archetype];
  const wrapper = entry.wrapperLabel?.symbol ?? "wrapper";
  const item = (mark: string, tone: string, text: string) => <li className="flex gap-2.5 border-b border-rule py-3 text-[15px]"><span className={`font-mono ${tone}`}>{mark}</span>{text}</li>;
  return (
    <div className="grid grid-cols-1 gap-x-12 md:grid-cols-2">
      <div>
        <h3 className="kicker pb-1">Enforced by code</h3>
        <ul>
          {item("✓", "text-green", "Supply can never grow.")}
          {item("✓", "text-green", `Every ${wrapper} is backed 1 : 1 in escrow.`)}
          {item("✓", "text-green", `The sale price can’t pass ${cap.multiple}.`)}
          {item("✓", "text-green", "Exchanges open at graduation, whatever the issuer does.")}
        </ul>
      </div>
      <div>
        <h3 className="kicker pb-1">Held by the issuer, by law</h3>
        <ul>
          {item("§", "text-amber", "Approves who may hold the security (KYC).")}
          {item("§", "text-amber", "Can freeze a holder or pause transfers.")}
          {item("§", "text-amber", "Can move the security under a court order.")}
        </ul>
      </div>
    </div>
  );
}

type Tab = "terms" | "proof" | "money" | "rules";

function Details({ entry, tab, onTab }: { entry: RegistryEntry; tab: Tab; onTab: (t: Tab) => void }) {
  const terms = entry.detail.terms ?? null;
  const tabs: [Tab, string][] = [["terms", "Terms"], ["proof", "Proof of backing"], ...(terms ? [["money", "Where the money goes"] as [Tab, string]] : []), ["rules", "Guarantees"]];
  return (
    <section id="details" className="flex scroll-mt-6 flex-col gap-2">
      <div role="tablist" aria-label="Details" className="flex gap-6 overflow-x-auto border-b border-rule">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => onTab(id)}
            className={`-mb-px shrink-0 cursor-pointer pt-2 pb-3 text-[15px] ${tab === id ? "border-b-2 border-ink font-semibold" : "text-mute hover:text-ink"}`}>{label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "terms" && <Terms entry={entry} terms={terms} />}
        {tab === "proof" && <Proof entry={entry} />}
        {tab === "money" && terms && <Money entry={entry} terms={terms} />}
        {tab === "rules" && <Rules entry={entry} />}
      </div>
    </section>
  );
}

/** Chart of the curve, in its own card. */
function Chart({ entry, terms }: { entry: RegistryEntry; terms: DbcConfig }) {
  const { launch, quote, raise } = entry;
  if (!quote) return null;
  const cap = ARCHETYPE_CEILING[launch.archetype];
  const d = launch.decimals;
  const filled = launch.stage === "Live" && raise !== null && raise.raised >= raise.target;
  const live = launch.stage === "Live" && entry.detail.pool && !filled;
  return (
    <div className="border border-line bg-surface p-4 sm:p-6">
      <CurveChart
        terms={terms}
        sqrtNow={live ? entry.detail.pool!.sqrtPrice : launch.stage === "Graduated" || filled ? terms.migrationSqrtPrice : null}
        finished={launch.stage === "Graduated" || filled}
        ceiling={ceilingPrice(terms.sqrtStartPrice, cap.sqrtBps, d)}
        ceilingLabel={cap.label}
        baseDecimals={d}
        quote={quote}
        wrapperSymbol={entry.wrapperLabel?.symbol ?? "the wrapper"}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

function Crumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="font-mono text-[13px] text-mute">
      <Link to="/registry" className="underline decoration-line underline-offset-2 hover:text-ink">Registry</Link> / <span aria-current="page">{name}</span>
    </nav>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="shell flex flex-col gap-4 py-20">
      <Crumb name="Not found" />
      <h1 className="font-serif text-5xl sm:text-6xl">{title}</h1>
      <div className="max-w-2xl text-lg leading-relaxed text-ink2">{children}</div>
      <Link to="/registry" className="mt-2 inline-flex min-h-12 w-fit items-center bg-blue px-5 font-semibold text-white hover:bg-blue-deep">Back to the registry</Link>
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

/** Whether the element with this id is on screen; used to hide the phone buy bar near the panel. */
function useInView(id: string, active: boolean) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = active ? document.getElementById(id) : null;
    if (!el) return;
    const observer = new IntersectionObserver(([e]) => setInView(e!.isIntersecting), { threshold: 0.15 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, active]);
  return inView;
}

export function AssetPage() {
  const { mint } = useParams();
  const asset = useAsset(mint);
  const entry = asset.data;
  const panelInView = useInView("trade", entry?.launch.stage === "Live");
  const { connection } = useConnection();
  // A pause by the issuer is public: every visitor sees it next to the stage.
  const paused = useQuery({
    queryKey: ["register", "paused", config.rpcUrl, entry?.launch.realRwaMint.toBase58()],
    enabled: Boolean(entry && isSet(entry.launch.realRwaMint) && entry.launch.stage !== "Aborted"),
    queryFn: () => loadPaused(connection, entry!.launch.realRwaMint),
    refetchInterval: config.refreshMs,
  });
  const [tab, setTab] = useState<Tab>(() => (typeof location !== "undefined" && location.hash === "#proof" ? "proof" : "terms"));

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
  const configured = ORDER.indexOf(launch.stage) >= ORDER.indexOf("Configured") && launch.stage !== "Aborted";
  const stage = STAGE[launch.stage];
  const pill = stage.group === "open" ? "border-blue text-blue" : stage.group === "graduated" ? "border-green text-green" : "border-line text-mute";
  const showProof = () => { setTab("proof"); document.getElementById("details")?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <div className={`shell flex flex-col gap-8 pt-6 lg:pt-8 ${launch.stage === "Live" ? "pb-32 md:pb-24" : "pb-24"}`}>
      {asset.isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-amber bg-amber-wash px-4 py-3 text-sm">
          <span>Couldn’t refresh from the network. The numbers may be out of date.</span>
          <button type="button" onClick={() => void asset.refetch()} className="min-h-11 cursor-pointer font-semibold underline underline-offset-4">Try again</button>
        </div>
      )}

      {/* Three blocks: on phones they stack as name/numbers, action box, details; on wide screens
          the action box sits beside both, sticky. */}
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-x-10">
        <div className="order-1 flex min-w-0 flex-col gap-8 lg:order-none lg:col-start-1 lg:row-start-1">
          <header className="flex flex-col gap-4">
            <Crumb name={name} />
            <h1 className="font-serif text-5xl leading-[0.98] sm:text-6xl xl:text-7xl">{name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink2">
              <span className={`inline-flex h-7 items-center rounded-full border px-2.5 font-semibold ${pill}`}>{stage.label}</span>
              {paused.data && (
                <span className="inline-flex h-7 items-center gap-1 rounded-full border border-amber bg-amber-wash px-2.5 font-semibold text-amber">
                  Transfers paused by the issuer<Hint>{sym ?? "The security"} can’t move or be redeemed until the issuer resumes. {wsym ?? "The wrapper"} still trades.</Hint>
                </span>
              )}
              {sym && <span className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface px-2.5"><strong className="font-mono font-medium">{sym}</strong> security</span>}
              {wsym && <span className="inline-flex h-7 items-center gap-1 rounded-full border border-line bg-surface px-2.5"><strong className="font-mono font-medium">{wsym}</strong> tradable wrapper</span>}
              <Hint label="How the two tokens work">
                {sym ?? "The security"} is the regulated security: only wallets the issuer approves can hold it. {wsym ?? "The wrapper"} is backed by it 1 : 1 and anyone can trade it. After the sale, approved holders can exchange one for the other.
              </Hint>
            </div>
          </header>
          {launch.stage === "Aborted" && <p role="status" className="border border-line bg-surface px-4 py-3 text-[15px]">Withdrawn before the sale. The asset went back to the issuer.</p>}
          {launch.stage !== "Aborted" && <Stats entry={entry} readAt={entry.readAt} onProof={showProof} />}
        </div>
        <div className="order-3 flex min-w-0 flex-col gap-8 lg:order-none lg:col-start-1 lg:row-start-2">
          {configured && detail.terms && <Chart entry={entry} terms={detail.terms} />}
          <Details entry={entry} tab={tab} onTab={setTab} />
        </div>

        <aside aria-label="Trade" className="order-2 flex flex-col gap-4 empty:hidden lg:order-none lg:sticky lg:top-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {/* Stays mounted after graduation so the buyer who completed the sale keeps their receipt;
              it renders nothing once the sale is filled unless it holds one. */}
          {(launch.stage === "Live" || launch.stage === "Graduated") && (
            <div id="trade" className="scroll-mt-6 empty:hidden"><TradePanel entry={entry} /></div>
          )}
          <GraduatePanel entry={entry} />
          {launch.stage === "Graduated" && <div id="exchange" className="scroll-mt-6"><BridgeBox entry={entry} /></div>}
          {(launch.stage === "TokenCreated" || launch.stage === "Funded" || launch.stage === "Configured") && (
            <div className="border border-line bg-surface p-5 text-[15px] text-ink2">The sale hasn’t opened yet. {stage.detail}.</div>
          )}
        </aside>
      </div>

      {launch.stage === "Live" && !panelInView && entry.price !== null && entry.quote && entry.raise && entry.raise.raised < entry.raise.target && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink bg-paper/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
          <a
            href="#trade"
            onClick={() => window.setTimeout(() => document.querySelector<HTMLInputElement>("#trade input")?.focus(), 350)}
            className="flex min-h-12 items-center justify-between bg-blue px-4 font-semibold text-white"
          >
            <span>Buy {entry.wrapperLabel?.symbol ?? ""}</span>
            <span className="font-mono text-sm num">
              {formatUnits(entry.price, entry.quote.decimals, { maxFraction: 4, minFraction: 3 })} {entry.quote.symbol}
            </span>
          </a>
        </div>
      )}
    </div>
  );
}
