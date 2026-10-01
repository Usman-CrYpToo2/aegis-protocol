import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import type { LaunchAccount } from "../chain/aegis";
import { STEP_IDS, abortInstructions, launchTransactions, loadIssueProgress, nextHolderIdFor, type AssetDetails, type StepId } from "../chain/issue";
import { loadPlatform, type Platform } from "../chain/platform";
import { decodeMint, mintLabel } from "../chain/token";
import { useConnectModal } from "../components/connect/ConnectModal";
import { Hint } from "../components/Hint";
import { AssetForm, EMPTY_ASSET, checkAsset, type AssetDraft } from "../components/issue/AssetForm";
import { TermsForm, TermsPreview, defaultTerms, readTerms, type TermsDraft } from "../components/issue/TermsForm";
import { TX_STEP, useTxRunner } from "../hooks/useTxRunner";
import { formatUnits, shortAddress } from "../lib/amount";
import { limitProblems, previewTerms, priceMultiple } from "../lib/terms";
import { ISSUE_ERRORS, explainTradeError, type Explained } from "../lib/txErrors";

/** Account deposits and network fees for a whole launch, on top of the platform fee (measured ~0.055). */
const DEPOSITS_LAMPORTS = 100_000_000n;
const sol = (lamports: bigint) => formatUnits(lamports, 9, { maxFraction: 3 });
const bytes = (s: string) => new TextEncoder().encode(s).length;
const btn = "min-h-12 cursor-pointer bg-blue px-6 text-[15px] font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40";
const ghost = "min-h-12 cursor-pointer border border-line px-5 text-[15px] hover:border-ink";

const STEP_TITLE: Record<StepId, string> = {
  create: "Create the security",
  register: "Set up the holder register",
  groups: "Add the Investors and Escrow groups",
  vault: "Register the escrow vault",
  yourself: "Register your wallet",
  fund: "Lock the supply in escrow",
  terms: "Fix the sale terms with Meteora",
  open: "Open the sale",
};

function usePlatform() {
  const { connection } = useConnection();
  return useQuery({ queryKey: ["platform", config.rpcUrl], queryFn: () => loadPlatform(connection), staleTime: 60_000 });
}

function useSol() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({ queryKey: ["sol", config.rpcUrl, publicKey?.toBase58()], enabled: Boolean(publicKey), queryFn: async () => BigInt(await connection.getBalance(publicKey!, "confirmed")), refetchInterval: config.refreshMs });
}

// ------------------------------------------------------------------------------------------------
// Sending the whole launch with one approval
// ------------------------------------------------------------------------------------------------

type Run =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "sending"; at: number; of: number; ids: StepId[]; done: Partial<Record<StepId, string>> }
  | { kind: "failed"; at: StepId | null; error: Explained; done: Partial<Record<StepId, string>> };

/**
 * The wallet approves every remaining step at once; they are then sent in order, each waiting for
 * the last. If one fails, everything before it is already on-chain, and the page resumes from there.
 */
function useLaunchRunner() {
  const { connection } = useConnection();
  const { signAllTransactions, signTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [run, setRun] = useState<Run>({ kind: "idle" });

  const start = async (build: (blockhash: string) => Promise<{ id: StepId; tx: VersionedTransaction }[]>): Promise<"done" | "partial" | "none"> => {
    const done: Partial<Record<StepId, string>> = {};
    let at: StepId | null = null;
    try {
      setRun({ kind: "signing" });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const batch = await build(blockhash);
      // The first step can be checked against the chain before anyone signs.
      const sim = await connection.simulateTransaction(batch[0]!.tx, { sigVerify: false, commitment: "confirmed" });
      if (sim.value.err) throw Object.assign(new Error(JSON.stringify(sim.value.err)), { logs: sim.value.logs ?? [] });
      const signed = signAllTransactions ? await signAllTransactions(batch.map((b) => b.tx)) : await Promise.all(batch.map((b) => signTransaction!(b.tx)));
      const ids = batch.map((b) => b.id);
      for (const [i, tx] of signed.entries()) {
        at = ids[i]!;
        setRun({ kind: "sending", at: i + 1, of: signed.length, ids, done: { ...done } });
        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: i > 0, preflightCommitment: "confirmed" });
        const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (result.value.err) {
          const info = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
          throw Object.assign(new Error(JSON.stringify(result.value.err)), { logs: info?.meta?.logMessages ?? [] });
        }
        done[at] = signature;
      }
      setRun({ kind: "idle" });
      return "done";
    } catch (e) {
      setRun({ kind: "failed", at, error: explainTradeError(e, ISSUE_ERRORS), done });
      return Object.keys(done).length ? "partial" : "none";
    } finally {
      for (const key of ["issue", "registry", "console", "sol", "asset"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  return { run, start };
}

function Progress({ run, ids }: { run: Run; ids: StepId[] }) {
  const done = run.kind === "sending" || run.kind === "failed" ? run.done : {};
  const current = run.kind === "sending" ? run.ids[run.at - 1] : run.kind === "failed" ? run.at : null;
  return (
    <ol className="flex flex-col border-t border-rule">
      {ids.map((id, i) => {
        const sig = done[id];
        const now = current === id;
        const failed = run.kind === "failed" && now;
        return (
          <li key={id} className="flex items-center justify-between gap-3 border-b border-rule py-2.5 text-sm">
            <span className="flex items-center gap-3">
              <span aria-hidden="true" className={`w-4 font-mono ${sig ? "text-green" : failed ? "text-error" : now ? "text-blue" : "text-mute"}`}>{sig ? "✓" : failed ? "!" : i + 1}</span>
              <span className={sig || now ? "" : "text-ink2"}>{STEP_TITLE[id]}</span>
            </span>
            {sig ? <a href={explorerUrl("tx", sig)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-green underline underline-offset-2">{shortAddress(sig)} ↗</a>
              : now && run.kind === "sending" ? <span className="text-xs text-blue">Confirming…</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function RunError({ run }: { run: Run }) {
  if (run.kind !== "failed") return null;
  const landed = Object.keys(run.done).length;
  return (
    <div role="alert" className="flex flex-col gap-1 border border-error bg-surface p-4 text-sm">
      <strong className="text-error">{run.error.title}</strong>
      <span className="leading-relaxed text-ink2">{run.error.detail}</span>
      {landed > 0 && <span className="text-mute">{landed} steps already landed and are saved. Finishing continues from the next one.</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Layout pieces
// ------------------------------------------------------------------------------------------------

const WIZARD = ["The asset", "Sale terms", "Review"] as const;

function Stepper({ at }: { at: number }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-3 text-sm">
      {WIZARD.map((title, i) => (
        <li key={title} aria-current={i === at ? "step" : undefined} className="flex items-center gap-3">
          <span className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 ${i === at ? "border-ink font-semibold" : i < at ? "border-green text-green" : "border-line text-mute"}`}>
            {i < at ? "✓" : `${i + 1}.`} {title}
          </span>
          {i < WIZARD.length - 1 && <span aria-hidden="true" className={`hidden h-px w-10 sm:block ${i < at ? "bg-green" : "bg-line"}`} />}
        </li>
      ))}
    </ol>
  );
}

function Frame({ at, title, children, side }: { at: number; title: string; children: ReactNode; side?: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-5">
        <Stepper at={at} />
        <h1 className="font-serif text-5xl leading-none sm:text-6xl">{title}</h1>
      </div>
      <div className={`grid grid-cols-1 items-start gap-10 ${side ? "xl:grid-cols-[minmax(0,1fr)_24rem]" : "max-w-4xl"}`}>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
        {side && <aside className="flex flex-col gap-4 xl:sticky xl:top-6">{side}</aside>}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 border-b border-rule py-3 text-[15px]"><span className="text-ink2">{k}</span><span className="text-right num">{children}</span></div>;
}

function termsSummary(t: TermsDraft, platform: Platform): [string, string][] | null {
  const r = readTerms(t, platform.quotes, platform.config);
  if (!r.ok) return null;
  const q = (v: bigint) => `${formatUnits(v, r.quote.decimals, { maxFraction: 4, minFraction: 2 })} ${r.quote.symbol}`;
  return [
    ["Opening price", q(r.terms.quoteAtomsPerToken)],
    ["May rise to", `${priceMultiple(r.terms.sqrtBps).toFixed(2)}× opening`],
    ["Raise", `${formatUnits(r.terms.targetRaise, r.quote.decimals, { maxFraction: 2 })} ${r.quote.symbol}`],
    ["Cash to you", `${r.terms.migrationFeePct}% of the raise`],
    ["Your pool share", `${r.terms.permanentPct}% locked forever${r.terms.vestedPct ? ` · ${r.terms.vestedPct}% over ${r.terms.vestingMonths} mo` : ""}`],
    ["Pool fee", `${(r.terms.poolFeeBps / 100).toFixed(2)}%`],
  ];
}

function termsBlocker(t: TermsDraft, platform: Platform, totalSupply: bigint, decimals: number): string | null {
  const r = readTerms(t, platform.quotes, platform.config);
  if (!r.ok) return r.message;
  const limits = limitProblems(r.terms, platform.config, r.quote.minRaise);
  if (limits.length) return limits[0]!;
  const pv = previewTerms(r.terms, platform.config, totalSupply, decimals);
  if (!pv.ok) return ISSUE_ERRORS[pv.error]?.title ?? "These terms don’t work.";
  return null;
}

function TermsStep({ terms, setTerms, platform, preview }: { terms: TermsDraft; setTerms: (t: TermsDraft) => void; platform: Platform; preview: ReactNode }) {
  const [custom, setCustom] = useState(false);
  const rows = termsSummary(terms, platform);
  return (
    <>
      {!custom ? (
        <div className="flex flex-col border border-ink bg-surface">
          <div className="flex items-center justify-between border-b border-ink px-5 py-3">
            <span className="flex items-center gap-2 font-semibold">Recommended terms<Hint>A sensible start within the platform’s limits. Customize any of it; the numbers update as you go.</Hint></span>
            <button type="button" onClick={() => setCustom(true)} className="min-h-10 cursor-pointer text-sm font-semibold text-blue underline underline-offset-4">Customize</button>
          </div>
          <div className="px-5 pb-2">{rows?.map(([k, v]) => <Row key={k} k={k}>{v}</Row>)}</div>
        </div>
      ) : (
        <>
          <button type="button" onClick={() => setCustom(false)} className="w-fit cursor-pointer text-sm text-ink2 underline underline-offset-4 hover:text-ink">Back to the summary</button>
          <TermsForm draft={terms} onChange={setTerms} quotes={platform.quotes} platform={platform.config} disabled={false} />
        </>
      )}
      <div className="border border-ink bg-surface p-5 xl:hidden">{preview}</div>
    </>
  );
}

const previewBox = (preview: ReactNode) => (
  <div className="hidden flex-col gap-3 border border-ink bg-surface p-5 xl:flex">
    <h2 className="font-semibold">What these terms mean</h2>
    {preview}
  </div>
);

// ------------------------------------------------------------------------------------------------
// A new launch: three steps, one approval
// ------------------------------------------------------------------------------------------------

const draftKey = (wallet: string) => `aegis.launch-draft.${wallet}`;
type Draft = { asset: AssetDraft; terms: TermsDraft; step: number };
function readDraft(wallet: string): Draft | null {
  try { const raw = localStorage.getItem(draftKey(wallet)); return raw ? (JSON.parse(raw) as Draft) : null; } catch { return null; }
}
function writeDraft(wallet: string, d: Draft | null) {
  try { if (d) localStorage.setItem(draftKey(wallet), JSON.stringify(d)); else localStorage.removeItem(draftKey(wallet)); } catch { /* convenience only */ }
}

function NewLaunch({ platform }: { platform: Platform }) {
  const { publicKey } = useWallet();
  const navigate = useNavigate();
  const balance = useSol();
  const me = publicKey!;
  const saved = useMemo(() => readDraft(me.toBase58()), [me]);
  const [asset, setAsset] = useState<AssetDraft>(saved?.asset ?? EMPTY_ASSET);
  // A saved draft can name a currency that no longer exists (it was delisted, or a local node was
  // reset): fall back to an approved one rather than leaving the issuer stuck.
  const [terms, setTerms] = useState<TermsDraft>(() =>
    saved?.terms && platform.quotes.some((q) => q.mint.toBase58() === saved.terms.quote) ? saved.terms : saved?.terms ? { ...saved.terms, quote: platform.quotes[0]!.mint.toBase58() } : defaultTerms(platform.config, platform.quotes[0]!));
  const [step, setStep] = useState(saved?.step ?? 0);
  const runner = useLaunchRunner();
  useEffect(() => writeDraft(me.toBase58(), { asset, terms, step }), [me, asset, terms, step]);

  const check = checkAsset(asset);
  const details: AssetDetails | null = "details" in check ? check.details : null;
  const totalSupply = details?.totalSupply ?? 0n;
  const need = platform.config.creationFeeLamports + DEPOSITS_LAMPORTS;
  const short = balance.data !== undefined && balance.data < need;
  const blocker = details ? termsBlocker(terms, platform, totalSupply, asset.decimals) : "Fill in the asset first.";
  const busy = runner.run.kind === "signing" || runner.run.kind === "sending";
  const result = readTerms(terms, platform.quotes, platform.config);
  const preview = <TermsPreview result={result} platform={platform.config} totalSupply={totalSupply} decimals={asset.decimals} symbol={details?.symbol ?? ""} curveFeeBps={platform.config.curveFeeBps} issuerCurveFeeSharePct={platform.config.issuerCurveFeeSharePct} />;

  const launch = async () => {
    if (!details || !result.ok || blocker) return;
    const rwa = Keypair.generate();
    const wrapperName = bytes(`Wrapped ${details.name}`) <= 32 ? `Wrapped ${details.name}` : details.name;
    const outcome = await runner.start(async (blockhash) => launchTransactions({
      mint: rwa.publicKey, issuer: me, feeRecipient: platform.config.feeRecipient,
      create: { keypair: rwa, details }, terms: { quoteMint: result.quote.mint, terms: result.terms },
      quoteProgram: result.quote.program, decimals: details.decimals, wrapper: { name: wrapperName, symbol: `c${details.symbol}`, uri: "" },
      firstHolderId: 0n, existing: null,
    }, [...STEP_IDS], blockhash));
    // Anything that landed is on-chain now: the launch's own page shows it, and finishes it if needed.
    if (outcome !== "none") {
      writeDraft(me.toBase58(), null);
      navigate(`/launch/${rwa.publicKey.toBase58()}`, { replace: true });
    }
  };

  if (step === 0) {
    return (
      <Frame at={0} title="The asset">
        <AssetForm draft={asset} onChange={setAsset} disabled={false} />
        <div><button type="button" className={btn} disabled={!details} onClick={() => setStep(1)}>Next: sale terms</button></div>
      </Frame>
    );
  }
  if (step === 1) {
    return (
      <Frame at={1} title="Sale terms" side={previewBox(preview)}>
        <TermsStep terms={terms} setTerms={setTerms} platform={platform} preview={preview} />
        {blocker && <p role="alert" className="text-sm text-error">{blocker}</p>}
        <div className="flex gap-3">
          <button type="button" className={ghost} onClick={() => setStep(0)}>Back</button>
          <button type="button" className={btn} disabled={Boolean(blocker)} onClick={() => setStep(2)}>Next: review</button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame at={2} title="Review and launch" side={
      <div className="flex flex-col gap-3 border border-ink bg-surface p-5 text-[15px]">
        <div className="flex items-baseline justify-between"><span className="text-ink2">Platform fee</span><span className="num">{sol(platform.config.creationFeeLamports)} SOL</span></div>
        <div className="flex items-baseline justify-between"><span className="flex items-center gap-1 text-ink2">Deposits and fees<Hint>Solana holds a small deposit for each new account the launch creates.</Hint></span><span className="num">≈ {sol(DEPOSITS_LAMPORTS)} SOL</span></div>
        <div className="flex items-baseline justify-between border-t border-rule pt-3"><span className="text-ink2">Your balance</span><span className={`num ${short ? "text-error" : ""}`}>{balance.data === undefined ? "—" : `${sol(balance.data)} SOL`}</span></div>
        {short && <p role="alert" className="text-[13px] text-error">You need about {sol(need)} SOL.</p>}
        {platform.config.isPaused && <p role="alert" className="text-[13px] text-error">Aegis isn’t accepting launches right now.</p>}
        <button type="button" className={`${btn} mt-1`} disabled={busy || short || platform.config.isPaused || Boolean(blocker)} onClick={() => void launch()}>
          {runner.run.kind === "signing" ? "Approve in your wallet…" : runner.run.kind === "sending" ? `Launching… ${runner.run.at} of ${runner.run.of}` : "Launch · approve once"}
        </button>
        <p className="text-[13px] leading-relaxed text-mute">One wallet approval covers all {STEP_IDS.length} transactions. The terms are final once launched.</p>
      </div>
    }>
      <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
        <div>
          <h2 className="kicker pb-1">Asset</h2>
          <Row k="Name">{details?.name}</Row>
          <Row k="Security">{details?.symbol}</Row>
          <Row k="Tradable wrapper">c{details?.symbol}</Row>
          <Row k="Supply">{details ? formatUnits(details.totalSupply, details.decimals, { maxFraction: 0 }) : "—"}</Row>
        </div>
        <div>
          <h2 className="kicker pb-1">Sale</h2>
          {termsSummary(terms, platform)?.map(([k, v]) => <Row key={k} k={k}>{v}</Row>)}
        </div>
      </div>
      <RunError run={runner.run} />
      {busy ? <Progress run={runner.run} ids={[...STEP_IDS]} /> : (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer text-ink2 underline decoration-line underline-offset-4 hover:text-ink">What you’re approving ({STEP_IDS.length} transactions)</summary>
          <div className="mt-3"><Progress run={runner.run} ids={[...STEP_IDS]} /></div>
        </details>
      )}
      <div><button type="button" className={ghost} disabled={busy} onClick={() => setStep(1)}>Back</button></div>
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------------
// A launch that exists: finish it, or see that it's open
// ------------------------------------------------------------------------------------------------

function Continue({ mint, platform }: { mint: PublicKey; platform: Platform }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const me = publicKey!;
  const key = mint.toBase58();
  const progress = useQuery({ queryKey: ["issue", config.rpcUrl, key, me.toBase58()], queryFn: () => loadIssueProgress(connection, mint, me), refetchInterval: config.refreshMs });
  const label = useQuery({
    queryKey: ["issue-label", config.rpcUrl, key],
    queryFn: async () => { const info = await connection.getAccountInfo(mint, "confirmed"); return info ? mintLabel(decodeMint(mint, info)) : null; },
  });
  const [terms, setTerms] = useState<TermsDraft>(() => defaultTerms(platform.config, platform.quotes[0]!));
  const runner = useLaunchRunner();

  const p = progress.data;
  const box = (children: ReactNode) => <div className="flex max-w-3xl flex-col items-start gap-4 border border-ink bg-surface p-8">{children}</div>;
  if (!p) return progress.isError ? <p role="alert" className="text-error">This launch couldn’t be read. It retries automatically.</p> : <span aria-busy="true" className="h-64 animate-pulse bg-track/70" />;
  if (!p.launch) return box(<><strong className="font-serif text-3xl font-normal">No launch at this address</strong><Link to="/launch" className={`${btn} inline-flex items-center`}>Start a new launch</Link></>);
  const launch = p.launch;
  if (!launch.issuer.equals(me)) return box(<><strong className="font-serif text-3xl font-normal">This launch belongs to another wallet</strong><p className="text-ink2">Only its issuer, <span className="font-mono">{shortAddress(launch.issuer.toBase58())}</span>, can continue it.</p></>);

  const name = label.data?.name || "Your asset";
  const symbol = label.data?.symbol || "";
  const supply = formatUnits(launch.totalSupply, launch.decimals, { maxFraction: 0 });
  if (p.aborted) return box(<><span className="kicker">{name}</span><strong className="font-serif text-4xl font-normal">Cancelled</strong><p className="text-ink2">All {supply} {symbol} went back to your wallet.</p><Link to="/launch" className={`${btn} inline-flex items-center`}>Start a new launch</Link></>);
  if (p.next === null) {
    return box(<>
      <span className="kicker text-green">Launched</span>
      <strong className="font-serif text-5xl leading-tight font-normal">{name} is open for sale</strong>
      <p className="text-[17px] leading-relaxed text-ink2">Every c{symbol} is backed 1 : 1 by the {supply} {symbol} in escrow.</p>
      <div className="flex flex-wrap gap-3">
        <Link to={`/asset/${key}`} className={`${btn} inline-flex items-center`}>See your sale</Link>
        <Link to={`/console/${key}`} className={`${ghost} inline-flex items-center font-semibold`}>Open the console</Link>
      </div>
    </>);
  }

  const remaining = STEP_IDS.filter((s) => !p.done[s]);
  const needsTerms = !p.done.terms;
  const blocker = needsTerms ? termsBlocker(terms, platform, launch.totalSupply, launch.decimals) : null;
  const result = readTerms(terms, platform.quotes, platform.config);
  const busy = runner.run.kind === "signing" || runner.run.kind === "sending";
  const preview = <TermsPreview result={result} platform={platform.config} totalSupply={launch.totalSupply} decimals={launch.decimals} symbol={symbol} curveFeeBps={platform.config.curveFeeBps} issuerCurveFeeSharePct={platform.config.issuerCurveFeeSharePct} />;

  const finish = async () => {
    const fresh = (await loadIssueProgress(connection, mint, me)).launch!;
    const quoteMint = needsTerms && result.ok ? result.quote.mint : fresh.quoteMint;
    const quote = platform.quotes.find((q) => q.mint.equals(quoteMint));
    if (!quote || (needsTerms && !result.ok)) return;
    const wrapperName = bytes(`Wrapped ${name}`) <= 32 ? `Wrapped ${name}` : name;
    const first = p.done.register ? await nextHolderIdFor(connection, mint) : 0n;
    await runner.start(async (blockhash) => launchTransactions({
      mint, issuer: me, feeRecipient: platform.config.feeRecipient,
      terms: needsTerms && result.ok ? { quoteMint: result.quote.mint, terms: result.terms } : undefined,
      quoteProgram: quote.program, decimals: launch.decimals, wrapper: { name: wrapperName, symbol: `c${symbol}`, uri: "" },
      firstHolderId: first, existing: needsTerms ? null : { meteoraConfig: fresh.meteoraConfig, quoteMint: fresh.quoteMint },
    }, remaining, blockhash));
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <span className="kicker">Finish your launch</span>
        <h1 className="font-serif text-5xl leading-none sm:text-6xl">{name}</h1>
        <p className="text-[17px] text-ink2">{STEP_IDS.length - remaining.length} of {STEP_IDS.length} steps are done and saved. The rest takes one approval.</p>
      </div>
      <div className="grid grid-cols-1 items-start gap-10 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {needsTerms && <TermsStep terms={terms} setTerms={setTerms} platform={platform} preview={preview} />}
          <Progress run={runner.run} ids={remaining} />
          <RunError run={runner.run} />
        </div>
        <aside className="flex flex-col gap-4 xl:sticky xl:top-6">
          {needsTerms && previewBox(preview)}
          {blocker && <p role="alert" className="text-sm text-error">{blocker}</p>}
          <button type="button" className={btn} disabled={busy || Boolean(blocker)} onClick={() => void finish()}>
            {runner.run.kind === "signing" ? "Approve in your wallet…" : runner.run.kind === "sending" ? `Launching… ${runner.run.at} of ${runner.run.of}` : "Finish launch · approve once"}
          </button>
          {(launch.stage === "Funded" || launch.stage === "Configured") && p.done.yourself && <Cancel launch={launch} supply={supply} symbol={symbol} />}
        </aside>
      </div>
    </div>
  );
}

function Cancel({ launch, supply, symbol }: { launch: LaunchAccount; supply: string; symbol: string }) {
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const tx = useTxRunner(ISSUE_ERRORS);
  const busy = tx.phase.kind === "busy";
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="w-fit cursor-pointer text-sm text-error underline underline-offset-4">Cancel and take the escrow back</button>;
  return (
    <div role="group" aria-label="Cancel the launch" className="flex flex-col gap-3 border border-error bg-surface p-4 text-sm">
      <strong>Cancel for good?</strong>
      <p className="text-ink2">All {supply} {symbol} come back to your wallet and this launch ends.</p>
      {tx.phase.kind === "failed" && <p role="alert"><strong className="text-error">{tx.phase.error.title}.</strong> {tx.phase.error.detail}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void tx.run(() => abortInstructions(launch, publicKey!))} className="min-h-10 cursor-pointer bg-error px-4 font-semibold text-white disabled:opacity-50">{busy && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : "Cancel launch"}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-10 cursor-pointer border border-line px-4">Keep it</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function IssuePage() {
  const { mint } = useParams();
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const platform = usePlatform();
  const parsed = useMemo(() => { try { return mint ? new PublicKey(mint) : null; } catch { return undefined; } }, [mint]);

  useEffect(() => {
    document.title = "Launch an asset — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, []);

  const shell = (c: ReactNode) => <div className="shell flex flex-col gap-8 pt-8 pb-24 lg:pt-12">{c}</div>;
  if (!publicKey) {
    return shell(
      <div className="flex max-w-2xl flex-col items-start gap-4">
        <span className="kicker">Launch an asset</span>
        <h1 className="font-serif text-6xl leading-[0.98]">Issue a real asset</h1>
        <p className="text-lg leading-relaxed text-ink2">Three steps, one approval.</p>
        <button type="button" onClick={openConnect} className={btn}>Connect wallet</button>
      </div>
    );
  }
  if (parsed === undefined) return shell(<p className="text-error">That link isn’t a valid asset address.</p>);
  if (!platform.data) {
    return shell(platform.isError
      ? <div role="alert" className="border border-error bg-surface p-6"><strong>Aegis couldn’t be read on this network.</strong></div>
      : <span aria-busy="true" className="h-64 animate-pulse bg-track/70" />);
  }
  if (platform.data.quotes.length === 0) return shell(<p role="alert" className="text-error">No sale currency is approved on this network yet.</p>);
  return shell(parsed ? <Continue mint={parsed} platform={platform.data} /> : <NewLaunch platform={platform.data} />);
}
