import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { claimUnsoldInstruction, collectRaiseInstructions } from "../chain/collect";
import type { ConsoleLaunch } from "../chain/console";
import { loadHealth } from "../chain/health";
import { useConnectModal } from "../components/connect/ConnectModal";
import { Investors } from "../components/console/Investors";
import { Hint } from "../components/Hint";
import { GraduatePanel } from "../components/asset/GraduatePanel";
import { useAsset } from "../hooks/useAsset";
import { useConsole } from "../hooks/useConsole";
import { TX_STEP, useTxRunner, type TxPhase } from "../hooks/useTxRunner";
import { formatUnits, shortAddress } from "../lib/amount";
import { STAGE } from "../lib/stage";

const MONTH = 30 * 24 * 60 * 60;

function Status({ phase }: { phase: TxPhase }) {
  if (phase.kind === "failed") {
    return (
      <p role="alert" className="text-[13px] leading-relaxed">
        <strong className="text-error">{phase.error.title}.</strong> <span className="text-ink2">{phase.error.detail}</span>
      </p>
    );
  }
  if (phase.kind === "done") {
    return (
      <p role="status" className="text-[13px] text-green">
        Collected. <a href={explorerUrl("tx", phase.signature)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View the transaction ↗</a>
      </p>
    );
  }
  return null;
}

function Row({ title, body, hint, amount, action, children }: { title: string; body: ReactNode; hint?: ReactNode; amount: ReactNode; action: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-rule py-5 sm:grid-cols-[minmax(0,1fr)_12rem_9rem] sm:items-center sm:gap-6">
      <div className="flex flex-col gap-0.5">
        <strong className="flex items-center gap-1 text-[17px]">{title}{hint && <Hint>{hint}</Hint>}</strong>
        <div className="text-sm text-ink2">{body}</div>
        {children}
      </div>
      <div className="font-serif text-3xl leading-none num sm:text-right">{amount}</div>
      <div className="sm:justify-self-end">{action}</div>
    </div>
  );
}

function CollectButton({ phase, disabled, onClick, label = "Collect" }: { phase: TxPhase; disabled?: boolean; onClick: () => void; label?: string }) {
  const busy = phase.kind === "busy";
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled} className="min-h-11 w-full cursor-pointer bg-blue px-5 text-sm font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40 sm:w-36">
      {busy ? TX_STEP[phase.step] : label}
    </button>
  );
}

function Money({ launch: l }: { launch: ConsoleLaunch }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const raiseTx = useTxRunner();
  const unsoldTx = useTxRunner();
  const { launch, quote, detail } = l.entry;
  const terms = detail.terms;
  const sym = l.entry.label?.symbol ?? "the security";
  const fmtQ = (v: bigint) => (quote ? `${formatUnits(v, quote.decimals, { maxFraction: 2, minFraction: 2 })}` : "—");

  const collectRaise = () =>
    raiseTx.run(async () => {
      const info = await connection.getAccountInfo(launch.quoteMint, "confirmed");
      if (!info) throw new Error("The quote token couldn’t be read.");
      return collectRaiseInstructions(launch, publicKey!, info.owner);
    });
  const collectUnsold = () => unsoldTx.run(() => [claimUnsoldInstruction(launch, publicKey!)]);

  const vest = terms?.creatorVesting;
  const months = vest ? Math.round((vest.periods * vest.frequency) / MONTH) : 0;
  const feeShare = terms?.creatorTradingFeePct ?? 0;

  return (
    <section aria-labelledby="money-h" className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2">
        <h2 id="money-h" className="font-serif text-4xl">What you can collect</h2>

      </div>
      <div className="hidden border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute sm:grid sm:grid-cols-[minmax(0,1fr)_12rem_9rem] sm:gap-6">
        <span>SOURCE</span><span className="text-right">AVAILABLE NOW</span><span />
      </div>

      <Row
        title="Your raise"
        body={
          terms && quote ? (
            <>{terms.creatorMigrationFeePct === 100 ? "" : `${terms.creatorMigrationFeePct}% of `}{terms.migrationFeePct}% of {formatUnits(terms.migrationQuoteThreshold, quote.decimals, { maxFraction: 0 })} {quote.symbol}</>
          ) : "Set with the sale terms"
        }
        hint="Meteora holds your share of the raise for you, as the pool’s creator, until you collect it."
        amount={<>{fmtQ(l.payout.amount)} <span className="font-mono text-sm text-mute">{quote?.symbol}</span></>}
        action={
          l.payout.status === "collected" || raiseTx.phase.kind === "done" ? (
            <span className="text-sm font-semibold text-green">Collected ✓</span>
          ) : l.payout.status === "ready" ? (
            <CollectButton phase={raiseTx.phase} onClick={() => void collectRaise()} />
          ) : (
            <span className="text-[13px] text-mute">{l.payout.status === "at-graduation" ? "At graduation" : "—"}</span>
          )
        }
      >
        <Status phase={raiseTx.phase} />
      </Row>

      <Row
        title="Unsold stock"
        body="What the sale didn’t sell"
        hint="It waits in escrow and is paid only from what is above your holders’ backing."
        amount={<>{formatUnits(l.unsold, launch.decimals, { maxFraction: 2 })} <span className="font-mono text-sm text-mute">{sym}</span></>}
        action={
          l.unsold === 0n ? (
            <span className="text-[13px] text-mute">{launch.stage === "Graduated" ? "—" : "At graduation"}</span>
          ) : unsoldTx.phase.kind === "done" ? (
            <span className="text-sm font-semibold text-green">Collected ✓</span>
          ) : (
            <CollectButton phase={unsoldTx.phase} disabled={!l.issuerApproved} onClick={() => void collectUnsold()} />
          )
        }
      >
        {l.unsold > 0n && !l.issuerApproved && (
          <p className="mt-1 text-[13px] text-amber">Your wallet needs approval first. <Link to="?tab=investors" replace className="font-semibold underline underline-offset-2">Approve it</Link></p>
        )}
        <Status phase={unsoldTx.phase} />
      </Row>

      <Row
        title="Trading fees from the pool"
        body={terms ? <>{(terms.migratedPoolFeeBps / 100).toFixed(2).replace(/\.?0+$/, "")}% of every pool trade</> : "Set with the sale terms"}
        hint="Your locked liquidity earns fees after graduation. They build up safely in your positions until collecting them here is added."
        amount={<span className="text-base text-mute">—</span>}
        action={<span className="text-[13px] text-mute">Coming soon</span>}
      />

      {vest && (
        <Row
          title="Pool liquidity that unlocks"
          body={<>Over {months} months after graduation</>}
          hint="Released in monthly steps. Taking it out makes the market thinner for your buyers."
          amount={<span className="text-base">{vest.percentage}%</span>}
          action={<span className="text-[13px] text-mute">Schedule only</span>}
        />
      )}

      {feeShare > 0 && (
        <Row title="Fees from the sale" body={`${feeShare}% of the platform’s share of each sale trade`} amount={<span className="text-base">{feeShare}%</span>} action={null} />
      )}
    </section>
  );
}

function Health({ launch: l }: { launch: ConsoleLaunch }) {
  const { connection } = useConnection();
  const sym = l.entry.label?.symbol ?? "the security";
  const wsym = l.entry.wrapperLabel?.symbol ?? "the wrapper";
  const health = useQuery({
    queryKey: ["health", config.rpcUrl, l.entry.launch.address.toBase58(), l.waiting.length, l.entry.backing.kind, l.entry.launch.issuerUnsold.toString()],
    queryFn: () => loadHealth(connection, l.entry, l.waiting.length, { sym, wsym }),
    refetchInterval: 15_000,
  });
  return (
    <aside aria-label="What your holders are experiencing" className="flex h-fit flex-col gap-4">
      <div className="flex flex-col border border-ink bg-surface p-6">
        <h2 className="flex items-center gap-1 pb-2 text-[17px] font-semibold">Health<Hint>What your holders experience. Exchanges need every check to pass, and several depend on settings only you control in Upside. Buyers see the same on the asset page.</Hint></h2>
        {!health.data ? (
          <span aria-busy="true" className="my-3 h-24 animate-pulse bg-track/70" />
        ) : (
          <ul>
            {health.data.map((c) => (
              <li key={c.id} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3 border-b border-track py-3.5 text-sm leading-relaxed last:border-b-0">
                <span aria-hidden="true" className={`font-mono ${c.ok ? "text-green" : "text-amber"}`}>{c.ok ? "✓" : "!"}</span>
                <span className="flex items-center gap-1">{c.ok ? c.title : <strong>{c.title}</strong>}{!c.ok && <Hint>{c.detail}</Hint>}<span className="sr-only">{c.ok ? " (ok)" : ` (needs attention: ${c.detail})`}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>

    </aside>
  );
}

export function LaunchConsolePage() {
  const { mint } = useParams();
  const [params] = useSearchParams();
  const tab = params.get("tab") === "investors" ? "investors" : "money";
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const asset = useAsset(mint);
  const console_ = useConsole();
  const entry = asset.data;
  const mine = console_.data?.find((l) => l.entry.launch.realRwaMint.toBase58() === mint);

  useEffect(() => {
    document.title = entry?.label?.name ? `Console · ${entry.label.name} — Aegis` : "Console — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, [entry?.label?.name]);

  const shell = (children: ReactNode) => <div className="shell flex flex-col gap-8 pt-8 pb-24 lg:pt-10">{children}</div>;
  const name = entry?.label?.name || "Unnamed asset";

  if (!entry) {
    return shell(asset.isPending ? <span className="h-16 w-1/2 animate-pulse bg-track" aria-busy="true" /> : (
      <div className="flex flex-col gap-4 py-12">
        <h1 className="font-serif text-5xl">Not in the registry</h1>
        <Link to="/console" className="inline-flex min-h-12 w-fit items-center bg-blue px-5 font-semibold text-white">Back to your launches</Link>
      </div>
    ));
  }

  // Only the issuer manages a launch. Anyone else is told whose console this is.
  if (!publicKey || !entry.launch.issuer.equals(publicKey)) {
    return shell(
      <div className="flex flex-col items-start gap-3 border border-ink bg-surface p-8">
        <span className="kicker">A console link</span>
        <strong className="font-serif text-3xl font-normal">This console belongs to the issuer of {name}.</strong>
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink2">
          {publicKey ? <>The connected wallet, <span className="font-mono">{shortAddress(publicKey.toBase58())}</span>, did not issue it. If you are the issuer, switch to the wallet you launched with.</> : "Connect the wallet you launched with."}
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <button type="button" onClick={openConnect} className="min-h-11 cursor-pointer bg-ink px-5 text-sm font-semibold text-paper">{publicKey ? "Switch wallet" : "Connect wallet"}</button>
          <Link to={`/asset/${mint}`} className="inline-flex min-h-11 items-center border border-line px-5 text-sm hover:border-ink">View the public page</Link>
        </div>
      </div>
    );
  }

  const { launch, detail } = entry;
  const terms = detail.terms;
  return shell(<>
    <section className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="font-mono text-[13px] text-mute">
        <Link to="/console" className="underline decoration-line underline-offset-2 hover:text-ink">Issuer console</Link> / <span aria-current="page">{name}</span>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <h1 className="font-serif text-6xl leading-[0.98] sm:text-7xl lg:text-[80px]">{name}</h1>
          <div className="flex flex-wrap gap-2 text-[13px] text-ink2">
            <span className={`inline-flex h-7 items-center rounded-full border px-2.5 ${launch.stage === "Graduated" ? "border-green text-green" : "border-line"}`}>{STAGE[launch.stage].label}</span>
            <span className="inline-flex h-7 items-center rounded-full border border-line bg-surface px-2.5">{formatUnits(launch.totalSupply, launch.decimals, { maxFraction: 0 })} <span className="ml-1 font-mono">{entry.label?.symbol}</span>&nbsp;issued</span>
            {terms && <span className="inline-flex h-7 items-center rounded-full border border-line bg-surface px-2.5">Pool fee {(terms.migratedPoolFeeBps / 100).toFixed(2).replace(/\.?0+$/, "")}%</span>}
          </div>
        </div>
        <Link to={`/asset/${mint}`} className="inline-flex min-h-11 items-center border border-line bg-surface px-5 text-sm font-semibold hover:border-ink">See the page your buyers see ↗</Link>
      </div>
      <nav aria-label="Launch sections" className="flex gap-8 border-b border-rule">
        {(["money", "investors"] as const).map((id) => (
          <Link
            key={id}
            to={id === "money" ? "?" : "?tab=investors"}
            replace
            aria-current={tab === id ? "page" : undefined}
            className={`-mb-px pt-3.5 pb-3 text-[15px] ${tab === id ? "border-b-2 border-ink font-semibold" : "text-ink2 hover:text-ink"}`}
          >
            {id === "money" ? "Money" : "Investors"}
            {id === "investors" && mine && mine.waiting.length > 0 && <span className="font-mono text-xs text-amber"> · {mine.waiting.length} waiting</span>}
          </Link>
        ))}
        <span className="pt-3.5 pb-3 text-[15px] text-mute" title="Arrives in a later part">Legal powers</span>
      </nav>
    </section>

    <GraduatePanel entry={entry} tone="plain" />

    {!mine ? (
      <span aria-busy="true" aria-label="Loading" className="h-64 animate-pulse bg-track/70" />
    ) : tab === "investors" ? (
      <Investors launch={mine} />
    ) : (
      <div className="grid grid-cols-1 gap-12 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <Money launch={mine} />
        <Health launch={mine} />
      </div>
    )}
  </>);
}
