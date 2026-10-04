import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { config, explorerUrl } from "../config";
import type { Backing } from "../chain/backing";
import { ProgramNotDeployedError, type Registry, type RegistryEntry } from "../chain/registry";
import { Hint } from "../components/Hint";
import { useRegistry } from "../hooks/useRegistry";
import { useUsdTotal } from "../hooks/useUsdPrices";
import type { CurrencyAmount } from "../lib/usd";
import { formatMoney, formatUnits, percentOf, shortAddress } from "../lib/amount";
import { GROUP_ORDER, STAGE, type StageGroup } from "../lib/stage";

type Filter = "all" | StageGroup;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Offering open" },
  { id: "graduated", label: "Graduated" },
  { id: "preparing", label: "Preparing" },
];

// ------------------------------------------------------------------------------------------------
// Small pieces
// ------------------------------------------------------------------------------------------------

function Check({ className = "" }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function Warn({ className = "" }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </svg>
  );
}

function assetName(entry: RegistryEntry) {
  return entry.label?.name || "Unnamed asset";
}

function symbols(entry: RegistryEntry) {
  const real = entry.label?.symbol;
  const wrapper = entry.wrapperLabel?.symbol;
  if (real && wrapper) return `${real} / ${wrapper}`;
  return real ?? "";
}

function BackingCell({ backing, decimals }: { backing: Backing; decimals: number }) {
  switch (backing.kind) {
    case "backed":
      return (
        <span className="inline-flex items-center gap-2 font-semibold text-green" title={`${formatUnits(backing.escrowed, decimals)} in escrow for ${formatUnits(backing.circulating, decimals)} in circulation`}>
          <Check />1 : 1<span className="sr-only"> backed</span>
        </span>
      );
    case "escrowed":
      return (
        <span className="inline-flex items-center gap-2 font-semibold text-green">
          <Check />
          escrowed
        </span>
      );
    case "short":
      return (
        <span className="inline-flex items-center gap-2 font-semibold text-error">
          <Warn />
          short {formatUnits(backing.required - backing.escrowed, decimals, { maxFraction: 2 })}
        </span>
      );
    case "unknown":
      return (
        <span className="inline-flex items-center gap-2 text-amber" title={backing.reason}>
          <Warn />
          couldn’t verify
        </span>
      );
    case "not-funded":
      return <span className="text-mute">not funded yet</span>;
    case "withdrawn":
      return <span className="text-mute">returned to issuer</span>;
  }
}

function StageCell({ entry }: { entry: RegistryEntry }) {
  const stage = STAGE[entry.launch.stage];
  const tone =
    stage.group === "open" ? "text-blue" : stage.group === "graduated" ? "text-green" : "text-mute";
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${tone}`}>
      {stage.group === "open" && <span className="size-2 rounded-full bg-blue" aria-hidden="true" />}
      {stage.group === "graduated" && (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8M6 2l3 3-3 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      )}
      {stage.group === "preparing" && <span className="size-2 rounded-full border-[1.5px] border-mute" aria-hidden="true" />}
      <span>
        {stage.label}
        {stage.step && <span className="font-normal"> · step {stage.step} of 5</span>}
      </span>
    </span>
  );
}

function PriceCell({ entry }: { entry: RegistryEntry }) {
  if (entry.price !== null && entry.quote) {
    return (
      <span className="font-mono text-base num">
        {formatUnits(entry.price, entry.quote.decimals, { maxFraction: 4, minFraction: 3 })}{" "}
        <span className="text-xs text-mute">{entry.quote.symbol}</span>
      </span>
    );
  }
  if (entry.launch.stage === "Graduated") return <span className="text-sm text-mute">On Meteora</span>;
  return <span className="text-mute" aria-label="No price yet">—</span>;
}

function RaiseCell({ entry }: { entry: RegistryEntry }) {
  const { raise, quote } = entry;
  if (!raise || !quote) {
    return <span className="text-sm text-mute">{STAGE[entry.launch.stage].detail}</span>;
  }
  const pct = percentOf(raise.raised, raise.target);
  const fmt = (v: bigint) => formatMoney(v, quote.decimals);
  if (entry.launch.stage === "Graduated") {
    return <span className="text-sm text-ink2">Raised {fmt(raise.target)} {quote.symbol}</span>;
  }
  return (
    <span className="flex flex-col gap-1.5">
      <span className="text-[13px] num">
        {fmt(raise.raised)} of {fmt(raise.target)} {quote.symbol} · {pct}%
      </span>
      <span
        role="progressbar"
        aria-label={`${assetName(entry)} raise`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="block h-1 w-full max-w-80 bg-track"
      >
        <span className="block h-1 bg-ink" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function ExplorerLink({ address, children }: { address: string; children: ReactNode }) {
  return (
    <a href={explorerUrl("address", address)} target="_blank" rel="noopener noreferrer" className="text-mute underline decoration-line underline-offset-2 hover:text-ink">
      {children}
      <span className="sr-only"> (opens Solana Explorer)</span>
    </a>
  );
}

function AssetCell({ entry }: { entry: RegistryEntry }) {
  const mint = entry.launch.realRwaMint.toBase58();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Link to={`/asset/${mint}`} className="truncate font-serif text-[28px] leading-tight hover:underline hover:decoration-1 hover:underline-offset-4" title={assetName(entry)}>
        {assetName(entry)}
      </Link>
      <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-mute">
        {symbols(entry) && <span className="font-mono">{symbols(entry)}</span>}
        <ExplorerLink address={mint}>
          <span className="font-mono">{shortAddress(mint)}</span>
        </ExplorerLink>
      </span>
      {entry.problems.length > 0 && (
        <details className="mt-1 text-xs text-amber">
          <summary className="cursor-pointer">Some details couldn’t be read</summary>
          <ul className="mt-1 list-disc pl-4">
            {entry.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------
// Totals
// ------------------------------------------------------------------------------------------------

function Totals({ registry, failed }: { registry: Registry | undefined; failed: boolean }) {
  const stats = useMemo(() => {
    if (!registry) return null;
    const active = registry.entries.filter((e) => e.launch.stage !== "Aborted");
    const raised = new Map<string, CurrencyAmount>();
    for (const e of active) {
      if (!e.raise || !e.quote) continue;
      const key = e.quote.mint.toBase58();
      const row = raised.get(key) ?? { mint: key, symbol: e.quote.symbol, decimals: e.quote.decimals, atoms: 0n };
      row.atoms += e.raise.raised;
      raised.set(key, row);
    }
    const short = active.filter((e) => e.backing.kind === "short").length;
    const unknown = active.filter((e) => e.backing.kind === "unknown").length;
    return { assets: active.length, open: active.filter((e) => e.launch.stage === "Live").length, raised: [...raised.values()], short, unknown };
  }, [registry]);

  // Sales raise in different currencies; the total is one figure in US dollars at today's prices.
  const raisedUsd = useUsdTotal(stats?.raised ?? null);
  const cell = "flex flex-col gap-1 py-5";
  const value = "font-serif text-[40px] leading-none num";
  // Once a read has failed, stop pretending to load: show a dash instead of a pulsing block.
  const skeleton = failed ? (
    <span className="font-serif text-[40px] leading-none text-mute">—</span>
  ) : (
    <span className="mt-1 block h-9 w-24 animate-pulse bg-track" aria-hidden="true" />
  );

  return (
    <section aria-label="Registry totals" className="grid grid-cols-2 border-y border-ink">
      <div className={cell}>
        <span className="kicker">Assets registered</span>
        {stats ? <span className={value}>{stats.assets}</span> : skeleton}
      </div>
      <div className={`${cell} border-l border-rule pl-6`}>
        <span className="kicker">Offerings open now</span>
        {stats ? <span className={value}>{stats.open}</span> : skeleton}
      </div>
      <div className={`${cell} border-t border-rule`}>
        <span className="flex items-center gap-1 kicker">Raised through Aegis<Hint>Every sale’s raise, added up in US dollars at today’s prices. Each sale shows its own currency on its page.</Hint></span>
        {!stats || raisedUsd.loading ? (
          skeleton
        ) : (
          <>
            <span className={value}>{raisedUsd.text}</span>
            {raisedUsd.note && <span className="text-[12px] text-mute">{raisedUsd.note}</span>}
          </>
        )}
      </div>
      <div className={`${cell} border-t border-l border-rule pl-6`}>
        <span className="kicker">Backing checked</span>
        {!stats ? (
          skeleton
        ) : stats.short > 0 ? (
          <span className={`${value} text-error`}>{stats.short} short</span>
        ) : stats.unknown > 0 ? (
          <span className={`${value} text-amber`}>{stats.unknown} unverified</span>
        ) : stats.assets === 0 ? (
          <span className={`${value} text-mute`}>—</span>
        ) : (
          <span className={`${value} text-green`}>all 1 : 1</span>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// States
// ------------------------------------------------------------------------------------------------

function Panel({ tone, title, children, action }: { tone: "neutral" | "warn" | "error"; title: string; children: ReactNode; action?: ReactNode }) {
  const border = tone === "error" ? "border-error" : tone === "warn" ? "border-amber" : "border-line";
  return (
    <div role={tone === "neutral" ? "status" : "alert"} className={`flex flex-col gap-3 border ${border} bg-surface p-6 sm:p-8`}>
      <h2 className="font-serif text-3xl">{title}</h2>
      <div className="max-w-2xl text-[15px] leading-relaxed text-ink2">{children}</div>
      {action}
    </div>
  );
}

function Command({ children }: { children: string }) {
  return <code className="bg-paper px-1.5 py-0.5 font-mono text-[13px] text-ink">{children}</code>;
}

function RetryButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className="inline-flex min-h-11 w-fit cursor-pointer items-center bg-ink px-5 text-sm font-semibold text-paper hover:bg-ink2 disabled:cursor-wait disabled:opacity-60">
      {busy ? "Trying again…" : "Try again"}
    </button>
  );
}

function SkeletonRows() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-6 border-b border-rule py-6">
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-6 w-2/5 animate-pulse bg-track" />
            <span className="h-3 w-1/4 animate-pulse bg-track/60" />
          </span>
          <span className="hidden h-3.5 w-28 animate-pulse bg-track/60 md:block" />
          <span className="hidden h-3.5 w-20 animate-pulse bg-track/60 md:block" />
          <span className="hidden h-3.5 w-40 animate-pulse bg-track/60 md:block" />
          <span className="h-3.5 w-14 animate-pulse bg-track/60" />
        </div>
      ))}
    </div>
  );
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)} min ago`;
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function RegistryPage() {
  const registry = useRegistry();
  useEffect(() => {
    document.title = "Aegis — The Registry";
  }, []);
  const navigate = useNavigate();
  // The name is the real link (keyboard and screen readers); clicking anywhere else on the row is
  // a convenience for mouse users, ignored when the click was on a link or while selecting text.
  const openRow = (e: React.MouseEvent, mint: string) => {
    if ((e.target as HTMLElement).closest("a, button, summary") || window.getSelection()?.toString()) return;
    navigate(`/asset/${mint}`);
  };
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => {
    const entries = registry.data?.entries ?? [];
    return [...entries].sort((a, b) => {
      const g = GROUP_ORDER[STAGE[a.launch.stage].group] - GROUP_ORDER[STAGE[b.launch.stage].group];
      return g !== 0 ? g : assetName(a).localeCompare(assetName(b));
    });
  }, [registry.data]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, open: 0, graduated: 0, preparing: 0, withdrawn: 0 };
    for (const e of sorted) {
      c.all += 1;
      c[STAGE[e.launch.stage].group] += 1;
    }
    return c;
  }, [sorted]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((e) => {
      if (filter !== "all" && STAGE[e.launch.stage].group !== filter) return false;
      if (!q) return true;
      return [assetName(e), e.label?.symbol, e.wrapperLabel?.symbol, e.launch.realRwaMint.toBase58(), e.launch.crwaMint.toBase58()]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [sorted, filter, query]);

  const data = registry.data;
  const notDeployed = registry.error instanceof ProgramNotDeployedError;
  const refreshing = registry.isFetching;

  let body: ReactNode;
  if (!data && registry.isPending) {
    body = <SkeletonRows />;
  } else if (!data && notDeployed) {
    body = (
      <Panel tone="warn" title={`Aegis isn’t on ${config.cluster} yet`}>
        <p>The program was not found at this network’s address, so there is nothing to list.</p>
        {config.cluster === "localnet" && (
          <p className="mt-2">
            Deploy it to the local node with <Command>yarn localnet:deploy</Command>, then refresh.
          </p>
        )}
      </Panel>
    );
  } else if (!data) {
    body = (
      <Panel tone="error" title="Can’t reach the network" action={<RetryButton onClick={() => void registry.refetch()} busy={refreshing} />}>
        <p>
          The registry is read straight from the chain at <span className="font-mono text-[13px]">{config.rpcUrl}</span>, and that node isn’t answering.
        </p>
        {config.cluster === "localnet" && (
          <p className="mt-2">
            Is the local validator running? Start it with <Command>yarn localnet</Command>.
          </p>
        )}
      </Panel>
    );
  } else if (sorted.length === 0) {
    body = (
      <Panel tone="neutral" title="No assets registered yet">
        <p>When an issuer files an asset, it appears here with its backing, checked live.</p>
        {config.cluster === "localnet" && (
          <p className="mt-2">
            To see one locally, run <Command>yarn localnet:launch</Command>.
          </p>
        )}
      </Panel>
    );
  } else if (visible.length === 0) {
    body = (
      <div role="status" className="flex flex-col items-start gap-3 border-b border-rule py-10">
        <p className="text-ink2">
          {query ? <>Nothing matches “{query}”{filter !== "all" && " in this filter"}.</> : "No assets in this stage right now."}
        </p>
        <button type="button" onClick={() => { setQuery(""); setFilter("all"); }} className="min-h-11 cursor-pointer text-sm font-semibold text-blue underline underline-offset-4">
          Show every asset
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {/* Wide screens: a real table, so screen readers get rows and columns. */}
        <table className="hidden w-full border-collapse md:table">
          <caption className="sr-only">Registered assets, their stage, price, raise and backing</caption>
          <thead>
            <tr className="border-b border-ink text-left font-mono text-xs tracking-[0.04em] text-mute">
              <th scope="col" className="py-2.5 font-normal">ASSET</th>
              <th scope="col" className="py-2.5 font-normal">STAGE</th>
              <th scope="col" className="py-2.5 font-normal">PRICE</th>
              <th scope="col" className="py-2.5 font-normal">RAISE</th>
              <th scope="col" className="py-2.5 text-right font-normal">BACKING</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.launch.address.toBase58()} onClick={(ev) => openRow(ev, e.launch.realRwaMint.toBase58())} className={`cursor-pointer border-b border-rule align-middle hover:bg-surface ${e.launch.stage === "Aborted" ? "opacity-60" : ""}`}>
                <td className="max-w-[26rem] py-5 pr-6"><AssetCell entry={e} /></td>
                <td className="py-5 pr-6"><StageCell entry={e} /></td>
                <td className="py-5 pr-6"><PriceCell entry={e} /></td>
                <td className="py-5 pr-6"><RaiseCell entry={e} /></td>
                <td className="py-5 text-right text-[13px]"><BackingCell backing={e.backing} decimals={e.launch.decimals} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Narrow screens: one card per asset, no sideways scrolling. */}
        <ul className="flex flex-col md:hidden">
          {visible.map((e) => (
            <li key={e.launch.address.toBase58()} className={`flex flex-col gap-3 border-b border-rule py-5 ${e.launch.stage === "Aborted" ? "opacity-60" : ""}`}>
              <AssetCell entry={e} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StageCell entry={e} />
                <span className="text-[13px]"><BackingCell backing={e.backing} decimals={e.launch.decimals} /></span>
              </div>
              {e.price !== null && <PriceCell entry={e} />}
              <RaiseCell entry={e} />
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="shell flex flex-col gap-10 pt-10 pb-24 lg:gap-12 lg:pt-16">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,40rem)] xl:items-end xl:gap-16">
      <section className="flex flex-col gap-5">
        <span className="kicker">A public register of real assets on Solana</span>
        <h1 className="font-serif text-6xl leading-[0.98] sm:text-7xl lg:text-[88px]">The Registry</h1>
        <p className="max-w-3xl text-lg leading-relaxed text-ink2 lg:text-xl">
          Real assets held in escrow, each with a wrapper anyone can trade, 1 : 1.
        </p>
        <Link to="/launch" className="w-fit text-sm text-ink2 underline decoration-line underline-offset-4 hover:text-ink hover:decoration-ink">Issuing an asset? Launch it on Aegis →</Link>
      </section>

      <Totals registry={data} failed={!data && registry.isError} />
      </div>

      {data && registry.isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-amber bg-amber-wash px-4 py-3 text-sm">
          <span>Couldn’t refresh from the network. Showing what was read {ago(data.readAt)}.</span>
          <RetryButton onClick={() => void registry.refetch()} busy={refreshing} />
        </div>
      )}
      {data && data.unreadable > 0 && (
        <div role="status" className="border border-amber bg-amber-wash px-4 py-3 text-sm">
          {data.unreadable === 1 ? "One launch account" : `${data.unreadable} launch accounts`} couldn’t be read and {data.unreadable === 1 ? "is" : "are"} not shown. This usually means the app is older than the program.
        </div>
      )}

      <section aria-label="Assets" className="flex flex-col">
        {data && data.entries.length > 0 && (
        <div className="flex flex-col gap-4 pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div role="group" aria-label="Filter by stage" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`inline-flex min-h-10 cursor-pointer items-center gap-2 px-4 text-sm ${
                  filter === f.id ? "bg-ink font-semibold text-paper" : "border border-line font-medium text-ink hover:border-ink"
                }`}
              >
                {f.label}
                {data && <span className={`num text-xs ${filter === f.id ? "text-line" : "text-mute"}`}>{counts[f.id]}</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <label className="flex h-10 items-center gap-2 border border-line bg-surface px-3 focus-within:border-ink sm:w-80">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C574C" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-4-4" />
              </svg>
              <span className="sr-only">Search the registry</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value.slice(0, 64))}
                placeholder="Name, symbol or mint address"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-transparent text-sm outline-none placeholder:text-mute"
              />
            </label>
          </div>
        </div>
        )}

        {body}

        {data && (
          <p className="mt-3 flex items-center gap-3 font-mono text-xs text-mute">
            <span aria-live="polite">{refreshing ? "Checking the chain…" : `Read from ${config.cluster} ${ago(data.readAt)} · refreshes every ${config.refreshMs / 1000}s`}</span>
            <button type="button" onClick={() => void registry.refetch()} disabled={refreshing} className="min-h-11 cursor-pointer underline underline-offset-2 hover:text-ink disabled:cursor-wait disabled:no-underline">
              Refresh now
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
