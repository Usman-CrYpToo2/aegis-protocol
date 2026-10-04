import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { config, explorerUrl } from "../config";
import type { Activity } from "../chain/activity";
import type { Holding } from "../chain/holdings";
import { Hint } from "../components/Hint";
import { useConnectModal } from "../components/connect/ConnectModal";
import { useActivity, useHoldings } from "../hooks/useHoldings";
import { useNow } from "../hooks/useNow";
import { useUsdPrices, useUsdTotal } from "../hooks/useUsdPrices";
import { ShowMore, usePaged } from "../components/ShowMore";

/** Holdings per page: a portfolio stays scannable however many assets it holds. */
const HOLDINGS_PAGE = 20;
import type { CurrencyAmount } from "../lib/usd";
import { useRegistry } from "../hooks/useRegistry";
import { formatMoney, formatPrice, formatUnits, percentOf, shortAddress } from "../lib/amount";

// ------------------------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------------------------

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
);
const Bang = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
);

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => undefined)}
      className="inline-flex min-h-10 cursor-pointer items-center justify-center border border-line px-4 text-sm hover:border-ink"
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

function StageLine({ h }: { h: Holding }) {
  const { launch, raise } = h.entry;
  if (launch.stage === "Live") {
    const pct = raise ? percentOf(raise.raised, raise.target) : 0;
    const full = raise !== null && raise.raised >= raise.target;
    return (
      <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-blue">
        <span className="size-2 rounded-full bg-blue" aria-hidden="true" />
        {full ? "Sale filled · moving to its pool" : `Offering open · ${pct}% filled`}
      </span>
    );
  }
  if (launch.stage === "Graduated") {
    return (
      <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-green">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8M6 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
        Graduated · bridge open
      </span>
    );
  }
  return <span className="text-[13px] text-mute">Preparing</span>;
}

function Amount({ value, symbol, note, d }: { value: bigint; symbol: string; note: ReactNode; d: number }) {
  return (
    <span className="flex flex-col">
      <span className="font-serif text-3xl leading-tight num">
        {formatMoney(value, d)} <span className="font-mono text-[13px]">{symbol}</span>
      </span>
      <span className="text-[13px] text-mute">{note}</span>
    </span>
  );
}

function HoldingRow({ h, address }: { h: Holding; address: string }) {
  const { entry } = h;
  const { launch } = entry;
  const mint = launch.realRwaMint.toBase58();
  const d = launch.decimals;
  const name = entry.label?.name || "Unnamed asset";
  const sym = entry.label?.symbol ?? "security";
  const wsym = entry.wrapperLabel?.symbol ?? "wrapper";
  const q = entry.quote;
  const graduated = launch.stage === "Graduated";
  const short = entry.backing.kind === "short";
  const priceText = h.price !== null && q ? `${h.priceSource === "pool" ? "pool" : "sale"} price ${formatPrice(h.price, q.decimals)}` : "";

  let status: ReactNode;
  if (short) {
    status = (
      <>
        <span className="flex gap-2 font-semibold text-error"><Bang />Backing is short</span>
        <span className="text-ink2">The escrow holds less than it should, so the bridge has stopped for everyone. <Link to={`/asset/${mint}#proof`} className="text-blue underline underline-offset-2">See the proof</Link>.</span>
      </>
    );
  } else if (h.approved) {
    status = (
      <>
        <span className="flex gap-2 font-semibold text-green"><Tick />Approved by the issuer</span>
        <span className="text-ink2">
          {graduated ? "Redeem or deposit, 1 : 1." : `Redeem for ${sym} after the sale.`}
        </span>
      </>
    );
  } else {
    status = (
      <>
        <span className="flex gap-2 font-semibold text-amber"><Bang />Not approved yet</span>
        <span className="text-ink2">
          {graduated
            ? `Ask the issuer to approve your address to redeem ${sym}.`
            : `Needed to redeem ${sym} after the sale. Not needed to trade.`}
        </span>
      </>
    );
  }

  return (
    <li className="grid grid-cols-1 gap-5 border-b border-rule py-7 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.7fr)_12rem] md:gap-8">
      <span className="flex flex-col gap-1.5">
        <Link to={`/asset/${mint}`} className="font-serif text-[32px] leading-tight hover:underline hover:decoration-1 hover:underline-offset-4">{name}</Link>
        <StageLine h={h} />
        {h.isIssuer && <span className="w-fit bg-ink px-1.5 py-0.5 text-[11px] tracking-[0.08em] text-paper uppercase">You issued this</span>}
      </span>
      <span className="flex flex-col gap-3">
        {h.security > 0n && <Amount value={h.security} symbol={sym} d={d} note="the security, in your name" />}
        {h.wrapper > 0n && <Amount value={h.wrapper} symbol={wsym} d={d} note={`the wrapper${priceText ? ` · ${priceText}` : ""}`} />}
      </span>
      <span className="flex flex-col gap-2 text-sm leading-relaxed">{status}</span>
      <span className="flex flex-col gap-2">
        {graduated ? (
          <>
            <Link to={`/asset/${mint}#exchange`} className="inline-flex min-h-10 items-center justify-center bg-blue px-4 text-sm font-semibold text-white hover:bg-blue-deep">Exchange</Link>
            {h.pool && (
              <a href={explorerUrl("address", h.pool.toBase58())} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center justify-center border border-line px-4 text-sm hover:border-ink">
                Meteora pool ↗
              </a>
            )}
          </>
        ) : (
          <Link to={`/asset/${mint}#trade`} className="inline-flex min-h-10 items-center justify-center bg-blue px-4 text-sm font-semibold text-white hover:bg-blue-deep">Buy or sell</Link>
        )}
        {!h.approved && <CopyButton text={address} label="Copy my address" />}
      </span>
    </li>
  );
}

const WHAT: Record<Activity["kind"], (name: string) => string> = {
  bought: (n) => `Bought on the ${n} offering`,
  sold: (n) => `Sold on the ${n} offering`,
  redeemed: (n) => `Exchanged the wrapper for the security · ${n}`,
  deposited: (n) => `Exchanged the security for the wrapper · ${n}`,
  "pool-trade": (n) => `Traded on the Meteora pool · ${n}`,
  received: (n) => `Received · ${n}`,
  sent: (n) => `Sent · ${n}`,
  approved: (n) => `Approved by the issuer of ${n}`,
};

function when(time: number | null, now: number) {
  if (time === null) return "—";
  const s = Math.max(0, Math.round(now / 1000 - time));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(time * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function ActivityList({ items, loading, failed, now }: { items: Activity[] | undefined; loading: boolean; failed: boolean; now: number }) {
  return (
    <section aria-labelledby="activity-h" className="flex flex-col">
      <h2 id="activity-h" className="mb-3 font-serif text-4xl">Activity</h2>
      <div className="hidden border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute md:grid md:grid-cols-[9rem_minmax(0,1fr)_12rem_6rem] md:gap-5">
        <span>WHEN</span><span>WHAT</span><span className="text-right">AMOUNT</span><span />
      </div>
      {loading && !items ? (
        <div aria-busy="true" aria-label="Loading activity" className="flex flex-col">
          {[0, 1, 2].map((i) => <span key={i} className="my-3 h-5 animate-pulse bg-track/70" />)}
        </div>
      ) : failed && !items ? (
        <p role="alert" className="py-4 text-sm text-ink2">Your recent activity couldn’t be read right now. Your holdings above are unaffected.</p>
      ) : !items || items.length === 0 ? (
        <p className="py-4 text-sm text-mute">No activity yet.</p>
      ) : (
        <ul className="flex flex-col">
          {items.map((a) => {
            const e = a.holding.entry;
            const name = e.label?.name ?? "this asset";
            const sym = a.token === "security" ? e.label?.symbol : e.wrapperLabel?.symbol;
            return (
              <li key={a.signature} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-1 border-b border-rule py-3.5 text-sm md:grid-cols-[9rem_minmax(0,1fr)_12rem_6rem] md:items-center">
                <span className="text-mute md:order-none">{when(a.time, now)}</span>
                <span className="col-span-2 md:col-span-1">{WHAT[a.kind](name)}</span>
                <span className="font-mono num md:text-right">
                  {a.amount === null ? "—" : `${a.amount > 0n ? "+" : "−"}${formatUnits(a.amount < 0n ? -a.amount : a.amount, e.launch.decimals, { maxFraction: 2 })} ${sym ?? ""}`}
                </span>
                <a href={explorerUrl("tx", a.signature)} target="_blank" rel="noopener noreferrer" className="justify-self-end text-blue underline underline-offset-2">
                  Receipt ↗<span className="sr-only"> (opens Solana Explorer)</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function HoldingsPage() {
  const { publicKey, connecting } = useWallet();
  const { open: openConnect } = useConnectModal();
  const registry = useRegistry();
  const holdings = useHoldings();
  const activity = useActivity(holdings.data);
  const now = useNow();

  useEffect(() => {
    document.title = "My holdings — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, []);

  const totals = useMemo(() => {
    const list = holdings.data ?? [];
    const byQuote = new Map<string, CurrencyAmount>();
    let unpriced = 0;
    for (const h of list) {
      const q = h.entry.quote;
      if (h.value === null || !q) { unpriced += 1; continue; }
      const row = byQuote.get(q.mint.toBase58()) ?? { mint: q.mint.toBase58(), symbol: q.symbol, decimals: q.decimals, atoms: 0n };
      row.atoms += h.value;
      byQuote.set(q.mint.toBase58(), row);
    }
    const short = list.filter((h) => h.entry.backing.kind === "short").length;
    return { values: [...byQuote.values()], unpriced, short };
  }, [holdings.data]);

  // Holdings are priced in each sale's own currency; the total is one figure in US dollars.
  const worthUsd = useUsdTotal(totals.values);

  // Largest first, in dollars so holdings in different currencies compare; unpriced ones last.
  const prices = useUsdPrices(totals.values.map((v) => ({ mint: v.mint, symbol: v.symbol })));
  const ordered = useMemo(() => {
    const usd = (h: Holding) => {
      const q = h.entry.quote;
      const p = q && h.value !== null ? prices.data?.get(q.mint.toBase58()) : undefined;
      return p === undefined || !q || h.value === null ? -1 : (Number(h.value) / 10 ** q.decimals) * p;
    };
    return [...(holdings.data ?? [])].sort((a, b) => usd(b) - usd(a));
  }, [holdings.data, prices.data]);
  const page = usePaged(ordered, HOLDINGS_PAGE);

  const head = (right?: ReactNode) => (
    <section className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-col gap-4">
        <span className="kicker">{publicKey ? <>Wallet <span className="font-mono tracking-normal normal-case">{shortAddress(publicKey.toBase58())}</span></> : "Your wallet"}</span>
        <h1 className="font-serif text-6xl leading-[0.98] sm:text-7xl lg:text-[80px]">My holdings</h1>

      </div>
      {right}
    </section>
  );

  let body: ReactNode;
  if (!publicKey) {
    body = (
      <>
        {head()}
        <div className="flex flex-col items-start gap-4 border border-line bg-surface p-8">
          <p className="max-w-xl text-[15px] leading-relaxed text-ink2">Connect a wallet to see what it holds. Nothing is signed just by connecting.</p>
          <button type="button" onClick={openConnect} disabled={connecting} className="min-h-12 cursor-pointer bg-ink px-6 font-semibold text-paper hover:bg-ink2 disabled:opacity-60">
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        </div>
      </>
    );
  } else if (!holdings.data) {
    body = (
      <>
        {head()}
        {holdings.isError || registry.isError ? (
          <div role="alert" className="flex flex-col gap-3 border border-error bg-surface p-6">
            <strong>Your holdings couldn’t be read</strong>
            <span className="text-sm text-ink2">The network at <span className="font-mono">{config.rpcUrl}</span> isn’t answering. Nothing is wrong with your wallet.</span>
            <button type="button" onClick={() => { void registry.refetch(); void holdings.refetch(); }} className="min-h-11 w-fit cursor-pointer bg-ink px-5 text-sm font-semibold text-paper">Try again</button>
          </div>
        ) : (
          <div aria-busy="true" aria-label="Loading your holdings" className="flex flex-col gap-4">
            {[0, 1].map((i) => <span key={i} className="h-28 animate-pulse bg-track/70" />)}
          </div>
        )}
      </>
    );
  } else {
    const worth = (
      <div className="flex flex-col gap-1 lg:items-end">
        <span className="flex items-center gap-1 kicker">Worth at current prices<Hint>Graduated assets at their live Meteora pool price; open offerings at the sale curve’s price. Added up in US dollars at today’s prices.</Hint></span>
        {totals.values.length === 0 ? (
          <span className="font-serif text-5xl text-mute">—</span>
        ) : worthUsd.loading ? (
          <span className="mt-1 block h-12 w-40 animate-pulse bg-track" aria-label="Loading" />
        ) : (
          <span className="font-serif text-5xl leading-none num lg:text-6xl">{worthUsd.text}</span>
        )}
        {!worthUsd.loading && worthUsd.note && <span className="text-[12px] text-mute">{worthUsd.note}</span>}
        <span className={`text-[13px] ${totals.short ? "text-error" : "text-mute"}`}>
          {totals.short ? `${totals.short} of your assets ${totals.short === 1 ? "is" : "are"} short of backing` : "All backed 1 : 1"}
          {totals.unpriced > 0 && ` · ${totals.unpriced} not priced yet`}
          {registry.data && ` · checked ${Math.max(0, Math.round((now - registry.data.readAt) / 1000))}s ago`}
        </span>
      </div>
    );
    body = (
      <>
        {head(worth)}
        {holdings.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3 border border-line bg-surface p-8">
            <strong className="font-serif text-3xl font-normal">You don’t hold any registered assets yet</strong>
            <p className="max-w-xl text-[15px] leading-relaxed text-ink2">Buy the wrapper of any open offering; it appears here straight away, with its backing checked.</p>
            <Link to="/registry" className="mt-2 inline-flex min-h-12 items-center bg-blue px-5 font-semibold text-white hover:bg-blue-deep">Browse the registry</Link>
          </div>
        ) : (
          <section aria-label="Assets you hold" className="flex flex-col">
            <div className="hidden border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.7fr)_12rem] md:gap-8">
              <span>ASSET</span><span>YOU HOLD</span><span>WHAT YOU CAN DO</span><span />
            </div>
            <ul className="flex flex-col">
              {page.shown.map((h) => <HoldingRow key={h.entry.launch.address.toBase58()} h={h} address={publicKey.toBase58()} />)}
            </ul>
            <ShowMore shown={page.shown.length} total={page.total} pageSize={HOLDINGS_PAGE} more={page.more} noun="holdings" />

          </section>
        )}
        {holdings.data.length > 0 && <ActivityList items={activity.data} loading={activity.isPending} failed={activity.isError} now={now} />}
      </>
    );
  }

  return <div className="shell flex flex-col gap-10 pt-10 pb-24 lg:gap-12 lg:pt-16">{body}</div>;
}
