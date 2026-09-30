import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { config } from "../config";
import type { Attention, ConsoleLaunch } from "../chain/console";
import { useConnectModal } from "../components/connect/ConnectModal";
import { useConsole } from "../hooks/useConsole";
import { useNow } from "../hooks/useNow";
import { useRegistry } from "../hooks/useRegistry";
import { formatUnits, percentOf, shortAddress } from "../lib/amount";
import { STAGE } from "../lib/stage";

// ------------------------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------------------------

const name = (l: ConsoleLaunch) => l.entry.label?.name || "Unnamed asset";
const mintOf = (l: ConsoleLaunch) => l.entry.launch.realRwaMint.toBase58();
const q = (l: ConsoleLaunch) => l.entry.quote;

function money(amount: bigint, l: ConsoleLaunch, frac = 2) {
  const quote = q(l);
  return quote ? `${formatUnits(amount, quote.decimals, { maxFraction: frac, minFraction: frac })} ${quote.symbol}` : "—";
}

function StageCell({ l }: { l: ConsoleLaunch }) {
  const { launch, raise } = l.entry;
  const stage = STAGE[launch.stage];
  if (launch.stage === "Live") {
    const pct = raise ? percentOf(raise.raised, raise.target) : 0;
    return (
      <span className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-blue"><span className="size-2 rounded-full bg-blue" aria-hidden="true" />Offering open</span>
        <span role="progressbar" aria-label="Raise" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="block h-1 w-32 bg-track"><span className="block h-1 bg-ink" style={{ width: `${pct}%` }} /></span>
      </span>
    );
  }
  if (launch.stage === "Graduated") {
    return (
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-green">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8M6 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>Graduated
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold text-mute">
      <span className="size-2 rounded-full border-[1.5px] border-mute" aria-hidden="true" />
      <span>{stage.label}{stage.step ? <span className="font-normal"> · step {stage.step} of 5</span> : null}</span>
    </span>
  );
}

function WaitingCell({ l }: { l: ConsoleLaunch }) {
  const { launch } = l.entry;
  const lines: ReactNode[] = [];
  if (l.payout.status === "ready") lines.push(<span key="p"><strong className="num">{money(l.payout.amount, l)}</strong> to collect</span>);
  if (l.payout.status === "collected") lines.push(<span key="p" className="text-mute">Raise collected</span>);
  if (l.unsold > 0n) lines.push(<span key="u"><span className="num">{formatUnits(l.unsold, launch.decimals, { maxFraction: 2 })}</span> {l.entry.label?.symbol} unsold stock</span>);
  if (l.waiting.length > 0) lines.push(<span key="w" className="text-amber">{l.waiting.length} {l.waiting.length === 1 ? "holder" : "holders"} waiting for approval</span>);
  if (launch.stage === "Live" && l.payout.status === "at-graduation") {
    lines.push(<span key="g" className="text-ink2"><span className="num">{money(l.payout.amount, l, 0)}</span> at graduation</span>);
  }
  if (["TokenCreated", "Funded", "Configured"].includes(launch.stage)) {
    lines.push(<span key="s" className="text-ink2">{launch.stage === "Configured" ? "Terms set, not opened" : "Not finished"}</span>);
  }
  return <span className="flex flex-col gap-1 text-sm">{lines.length ? lines : <span className="text-mute">Nothing waiting</span>}</span>;
}

const ICON = {
  warn: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8A5A00" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>,
  people: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16140F" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M3 19c.8-3.2 3.2-5 6-5s5.2 1.8 6 5" /><path d="M17 8v6M14 11h6" /></svg>,
  clock: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#5C574C" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  coin: <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1E6B45" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7c0 2.3-5 1.3-5 3.8 0 1 1 1.7 2.5 1.7s2.5-.5 2.5-1.5" /></svg>,
};

function AttentionItem({ a }: { a: Attention }) {
  const l = a.launch;
  const n = name(l);
  const sym = l.entry.label?.symbol ?? "the security";
  const toLaunch = `/console/${mintOf(l)}`;
  const row = (icon: ReactNode, title: string, body: string, action: ReactNode) => (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-4 border-b border-track px-5 py-4 last:border-b-0">
      {icon}
      <span className="flex flex-col gap-1"><strong className="text-[15px]">{title}</strong><span className="text-[13px] leading-relaxed text-ink2">{n} · {body}</span></span>
      {action}
    </li>
  );
  const btn = (to: string, label: string, dark = false) => (
    <Link to={to} className={`inline-flex min-h-10 items-center px-4 text-sm font-semibold ${dark ? "bg-ink text-paper hover:bg-ink2" : "border border-line hover:border-ink"}`}>{label}</Link>
  );
  switch (a.kind) {
    case "raise-ready":
      return row(ICON.coin, `${money(l.payout.amount, l)} is ready to collect`, "Your share of the raise", btn(toLaunch, "Collect", true));
    case "graduate":
      return row(ICON.coin, "Sale filled: graduate it", "Opens the bridge for your holders", btn(toLaunch, "Graduate", true));
    case "unsold-blocked":
      return row(ICON.warn, "Your unsold stock can’t reach you", "Approve your own wallet first", btn(`${toLaunch}?tab=investors`, "Fix", true));
    case "waiting":
      return row(ICON.people, `${a.count} ${a.count === 1 ? "holder is" : "holders are"} waiting for approval`, `They can’t redeem ${sym} yet`, btn(`${toLaunch}?tab=investors`, "Review"));
    case "unfinished":
      return row(ICON.clock, "Launch not finished", "Finish it with one approval", btn(`/launch/${mintOf(l)}`, "Continue"));
  }
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function ConsolePage() {
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const registry = useRegistry();
  const console_ = useConsole();
  const now = useNow();

  useEffect(() => {
    document.title = "Issuer console — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, []);

  const totals = useMemo(() => {
    const list = console_.data ?? [];
    const sum = (pick: (l: ConsoleLaunch) => bigint) => {
      const by = new Map<string, { symbol: string; decimals: number; total: bigint }>();
      for (const l of list) {
        const quote = q(l);
        const v = pick(l);
        if (!quote || v === 0n) continue;
        const row = by.get(quote.mint.toBase58()) ?? { symbol: quote.symbol, decimals: quote.decimals, total: 0n };
        row.total += v;
        by.set(quote.mint.toBase58(), row);
      }
      return [...by.values()];
    };
    return {
      ready: sum((l) => (l.payout.status === "ready" ? l.payout.amount : 0n)),
      atGraduation: sum((l) => (l.payout.status === "at-graduation" ? l.payout.amount : 0n)),
      unsold: list.filter((l) => l.unsold > 0n),
      waiting: list.reduce((n, l) => n + l.waiting.length, 0),
      short: list.filter((l) => l.entry.backing.kind === "short").length,
    };
  }, [console_.data]);

  const shell = (children: ReactNode) => <div className="shell flex flex-col gap-10 pt-10 pb-24 lg:gap-12 lg:pt-14">{children}</div>;
  const title = (kicker: ReactNode, text: string, right?: ReactNode) => (
    <section className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex max-w-3xl flex-col gap-4">
        <span className="kicker">{kicker}</span>
        <h1 className="font-serif text-6xl leading-[0.98] sm:text-7xl lg:text-[80px]">Your launches</h1>
        {text && <p className="text-lg leading-relaxed text-ink2">{text}</p>}
      </div>
      {right}
    </section>
  );

  if (!publicKey) {
    return shell(<>
      {title("Issuer console", "The console shows the launches a wallet issued: money to collect, investors to approve, launches to finish.")}
      <div className="flex flex-col items-start gap-4 border border-line bg-surface p-8">
        <p className="text-[15px] text-ink2">Connect the wallet you launched with.</p>
        <button type="button" onClick={openConnect} className="min-h-12 cursor-pointer bg-ink px-6 font-semibold text-paper hover:bg-ink2">Connect wallet</button>
      </div>
    </>);
  }

  if (console_.isIssuer === false) {
    return shell(<>
      {title("Issuer console", "This console belongs to issuers.")}
      <div className="flex flex-col items-start gap-3 border border-ink bg-surface p-8">
        <strong className="font-serif text-3xl font-normal">This wallet hasn’t issued an asset</strong>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink2">
          The connected wallet, <span className="font-mono">{shortAddress(publicKey.toBase58())}</span>, isn’t recorded as the issuer of any launch on {config.cluster}. Start one now, or if you already issued, switch to the wallet you launched with.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link to="/launch" className="inline-flex min-h-11 items-center bg-blue px-5 text-sm font-semibold text-white hover:bg-blue-deep">Launch an asset</Link>
          <button type="button" onClick={openConnect} className="min-h-11 cursor-pointer border border-line px-5 text-sm hover:border-ink">Switch wallet</button>
          <Link to="/" className="inline-flex min-h-11 items-center border border-line px-5 text-sm hover:border-ink">Back to the registry</Link>
        </div>
      </div>
    </>);
  }

  const data = console_.data;
  if (!data) {
    return shell(<>
      {title(<>Issuer console · <span className="font-mono tracking-normal normal-case">{shortAddress(publicKey.toBase58())}</span></>, "Reading your launches from the chain…")}
      {console_.isError || registry.isError ? (
        <div role="alert" className="flex flex-col gap-3 border border-error bg-surface p-6">
          <strong>Your launches couldn’t be read</strong>
          <span className="text-sm text-ink2">The network at <span className="font-mono">{config.rpcUrl}</span> isn’t answering.</span>
          <button type="button" onClick={() => { void registry.refetch(); void console_.refetch(); }} className="min-h-11 w-fit cursor-pointer bg-ink px-5 text-sm font-semibold text-paper">Try again</button>
        </div>
      ) : (
        <div aria-busy="true" aria-label="Loading your launches" className="flex flex-col gap-4">{[0, 1].map((i) => <span key={i} className="h-24 animate-pulse bg-track/70" />)}</div>
      )}
    </>);
  }

  const cell = "flex flex-col gap-1.5 py-5";
  const big = "font-serif text-[40px] leading-none num";
  const money2 = (rows: { symbol: string; decimals: number; total: bigint }[]) =>
    rows.length === 0 ? <span className={`${big} text-mute`}>0</span> : rows.map((r) => <span key={r.symbol} className={big}>{formatUnits(r.total, r.decimals, { maxFraction: 2 })} <span className="font-sans text-base text-mute">{r.symbol}</span></span>);
  const count = data.length === 1 ? "One entry" : data.length === 2 ? "Two entries" : data.length === 3 ? "Three entries" : `${data.length} entries`;

  return shell(<>
    {title(
      <>Issuer console · <span className="font-mono tracking-normal normal-case">{shortAddress(publicKey.toBase58())}</span></>,
      "",
    )}

    <section aria-label="Totals" className="grid grid-cols-1 border-y border-ink sm:grid-cols-2 xl:grid-cols-4">
      <div className={cell}>
        <span className="kicker">Ready to collect now</span>
        {money2(totals.ready)}
        {totals.unsold.length > 0 && (
          <span className="text-sm text-ink2">plus {totals.unsold.map((l) => `${formatUnits(l.unsold, l.entry.launch.decimals, { maxFraction: 2 })} ${l.entry.label?.symbol ?? ""}`).join(", ")} of unsold stock</span>
        )}
      </div>
      <div className={`${cell} border-t border-rule sm:border-t-0 sm:border-l sm:pl-6`}>
        <span className="kicker">Unlocks at graduation</span>
        {money2(totals.atGraduation)}
        <span className="text-[13px] text-mute">Your share of raises still open</span>
      </div>
      <div className={`${cell} border-t border-rule xl:border-t-0 xl:border-l xl:pl-6`}>
        <span className="kicker">Holders waiting for approval</span>
        <span className={`${big} ${totals.waiting ? "text-amber" : ""}`}>{totals.waiting}</span>
        <span className="text-[13px] text-mute">They hold the wrapper but can’t redeem</span>
      </div>
      <div className={`${cell} border-t border-rule sm:border-l sm:pl-6 xl:border-t-0`}>
        <span className="kicker">Backing, all launches</span>
        <span className={`${big} ${totals.short ? "text-error" : "text-green"}`}>{totals.short ? `${totals.short} short` : "all 1 : 1"}</span>
        {registry.data && <span className="text-[13px] text-mute">Checked {Math.max(0, Math.round((now - registry.data.readAt) / 1000))}s ago</span>}
      </div>
    </section>

    <div className="grid grid-cols-1 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_28rem]">
      <section aria-label="Launches" className="flex flex-col">
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
          <h2 className="font-serif text-4xl">{count} in your name</h2>
          <Link to="/launch" className="inline-flex min-h-10 items-center bg-blue px-4 text-sm font-semibold text-white hover:bg-blue-deep">Start a new launch</Link>
        </div>
        <div className="hidden border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,2fr)_7rem] md:gap-6">
          <span>ASSET</span><span>STAGE</span><span>WAITING FOR YOU</span><span />
        </div>
        <ul className="flex flex-col">
          {data.map((l) => (
            <li key={l.entry.launch.address.toBase58()} className="grid grid-cols-1 gap-3 border-b border-rule py-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,2fr)_7rem] md:items-center md:gap-6">
              <span className="flex flex-col gap-0.5">
                <span className="font-serif text-[28px] leading-tight">{name(l)}</span>
                <span className="text-[13px] text-mute">
                  {l.entry.raise && q(l) ? `${l.entry.launch.stage === "Graduated" ? "Raised" : "Raising"} ${formatUnits(l.entry.raise.target, q(l)!.decimals, { maxFraction: 0 })} ${q(l)!.symbol}` : `${formatUnits(l.entry.launch.totalSupply, l.entry.launch.decimals, { maxFraction: 0 })} units`} · <span className="font-mono">{l.entry.label?.symbol}</span>
                </span>
              </span>
              <StageCell l={l} />
              <WaitingCell l={l} />
              <Link
                to={["Live", "Graduated"].includes(l.entry.launch.stage) ? `/console/${mintOf(l)}` : l.entry.launch.stage === "Aborted" ? `/asset/${mintOf(l)}` : `/launch/${mintOf(l)}`}
                className="inline-flex min-h-10 items-center justify-center border border-ink px-4 text-sm font-semibold hover:bg-surface md:justify-self-end"
              >
                {["Live", "Graduated"].includes(l.entry.launch.stage) ? "Manage" : l.entry.launch.stage === "Aborted" ? "Open" : "Continue"}
              </Link>
            </li>
          ))}
        </ul>

      </section>

      <aside aria-label="Needs your attention" className="flex flex-col border border-ink bg-surface">
        <div className="flex items-baseline justify-between border-b border-ink px-5 py-4">
          <h2 className="text-[17px] font-semibold">Needs your attention</h2>
          <span className="font-mono text-xs text-mute">{console_.attention.length} {console_.attention.length === 1 ? "item" : "items"}</span>
        </div>
        {console_.attention.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink2">Nothing needs you right now.</p>
        ) : (
          <ul>{console_.attention.map((a) => <AttentionItem key={`${a.kind}-${a.launch.entry.launch.address.toBase58()}`} a={a} />)}</ul>
        )}

      </aside>
    </div>
  </>);
}
