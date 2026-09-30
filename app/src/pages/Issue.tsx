import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { config } from "../config";
import {
  INVESTOR_GROUP, VAULT_GROUP, abortInstructions, createInstructions, fundInstructions, groupInstructions, holderInstructions, issueAddresses,
  loadIssueProgress, nextHolderIdFor, openInstructions, registerInstructions, termsInstructions, type IssueProgress, type StepId,
} from "../chain/issue";
import { decodeDbcConfig } from "../chain/meteora";
import { loadPlatform, type Platform } from "../chain/platform";
import { decodeMint, mintLabel } from "../chain/token";
import { prepareTransaction } from "../chain/tx";
import { useConnectModal } from "../components/connect/ConnectModal";
import { AssetForm, EMPTY_ASSET, checkAsset, type AssetDraft } from "../components/issue/AssetForm";
import { SigningError, TxList, useSigning, type TxSpec } from "../components/issue/Signing";
import { TermsForm, TermsPreview, defaultTerms, readTerms, type TermsDraft } from "../components/issue/TermsForm";
import { TX_STEP, useTxRunner } from "../hooks/useTxRunner";
import { formatUnits, shortAddress, sqrtPriceToQuoteAtoms } from "../lib/amount";
import { priceMultiple } from "../lib/terms";
import { ISSUE_ERRORS, explainTradeError, type Explained } from "../lib/txErrors";

// ------------------------------------------------------------------------------------------------
// The five steps an issuer sees, and the eight transactions behind them
// ------------------------------------------------------------------------------------------------

type WizardId = "asset" | "compliance" | "escrow" | "terms" | "open";
const WIZARD: { id: WizardId; title: string; sub: string; txs: StepId[] }[] = [
  { id: "asset", title: "The asset", sub: "Name, symbol, supply", txs: ["create"] },
  { id: "compliance", title: "Compliance", sub: "Your holder register on Upside", txs: ["register", "groups", "vault", "yourself"] },
  { id: "escrow", title: "Escrow", sub: "Supply minted into the vault", txs: ["fund"] },
  { id: "terms", title: "Sale terms", sub: "Price, raise, liquidity", txs: [] },
  { id: "open", title: "Review & open", sub: "Sign twice to open the sale", txs: ["terms", "open"] },
];
const TX_COUNT = 8;
/** Account deposits and network fees for all eight transactions, on top of the platform fee. */
const DEPOSITS_LAMPORTS = 100_000_000n;

const btn = "min-h-12 cursor-pointer bg-blue px-6 text-[15px] font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40";
const sol = (lamports: bigint) => formatUnits(lamports, 9, { maxFraction: 3 });
const bytes = (s: string) => new TextEncoder().encode(s).length;

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
// Layout
// ------------------------------------------------------------------------------------------------

function Rail({ name, detail, states, signed }: { name: string; detail: string; states: Record<WizardId, "done" | "now" | "todo">; signed: number }) {
  return (
    <aside aria-label="Your progress" className="flex h-fit flex-col gap-3 lg:sticky lg:top-6 lg:gap-5">
      <div className="flex flex-col gap-1">
        <span className="kicker">Issuing</span>
        <strong className="font-serif text-3xl leading-tight font-normal">{name}</strong>
        <span className="font-mono text-xs text-mute">{detail}</span>
      </div>
      {/* On phones the step list folds into one line, so the form comes first. */}
      <p className="border-y border-ink py-2 text-sm lg:hidden">
        Step {WIZARD.findIndex((w) => states[w.id] === "now") + 1} of 5 · <strong>{WIZARD.find((w) => states[w.id] === "now")?.title}</strong>
        <span className="float-right font-mono text-xs text-mute">{signed}/{TX_COUNT} signed</span>
      </p>
      <ol className="hidden flex-col border-t border-ink lg:flex">
        {WIZARD.map((w, i) => {
          const s = states[w.id];
          return (
            <li key={w.id} aria-current={s === "now" ? "step" : undefined} className={`flex flex-col gap-0.5 border-b border-rule py-3 ${s === "now" ? "border-l-2 border-l-blue pl-3" : ""}`}>
              <span className={`font-mono text-xs ${s === "done" ? "text-green" : s === "now" ? "text-blue" : "text-mute"}`}>0{i + 1} · {s === "done" ? "done ✓" : s === "now" ? "now" : "next"}</span>
              <span className={`text-[15px] ${s === "todo" ? "text-mute" : "font-semibold"}`}>{w.title}</span>
              <span className="text-[13px] text-mute">{w.sub}</span>
            </li>
          );
        })}
      </ol>
      <div className="hidden flex-col gap-2 lg:flex">
        <div className="flex items-baseline justify-between text-[13px]"><span className="text-ink2">Signatures</span><span className="font-mono">{signed} of {TX_COUNT}</span></div>
        <div className="h-1.5 w-full bg-track"><div className="h-full bg-blue transition-[width] duration-500" style={{ width: `${(signed / TX_COUNT) * 100}%` }} /></div>
      </div>
      <p className="hidden text-[13px] leading-relaxed text-mute lg:block">Each finished step is saved on-chain. You can close this page and come back — Aegis picks up where you stopped.</p>
    </aside>
  );
}

function Panel({ kicker, title, intro, children }: { kicker: string; title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby="step-h" className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3">
        <span className="kicker">{kicker}</span>
        <h1 id="step-h" className="font-serif text-5xl leading-[1.02] sm:text-6xl">{title}</h1>
        <p className="max-w-3xl text-[17px] leading-relaxed text-ink2">{intro}</p>
      </div>
      {children}
    </section>
  );
}

function Costs({ platform, balance }: { platform: Platform; balance: bigint | undefined }) {
  const need = platform.config.creationFeeLamports + DEPOSITS_LAMPORTS;
  const enough = balance === undefined ? undefined : balance >= need;
  return (
    <div className="flex flex-col border border-ink bg-surface p-5 text-sm">
      <span className="kicker pb-2">Checked before you start</span>
      <div className="flex justify-between border-b border-track py-2"><span className="text-ink2">Platform fee</span><span className="num">{sol(platform.config.creationFeeLamports)} SOL</span></div>
      <div className="flex justify-between border-b border-track py-2"><span className="text-ink2">SOL needed for fees and accounts</span><span className="num">≈ {sol(need)} SOL</span></div>
      <div className="flex justify-between border-b border-track py-2"><span className="text-ink2">Your balance</span><span className={`num ${enough === false ? "text-error" : ""}`}>{balance === undefined ? "—" : `${sol(balance)} SOL`} {enough && <span className="text-green">✓</span>}</span></div>
      <div className="flex justify-between py-2"><span className="text-ink2">Network</span><span>{config.cluster === "localnet" ? "Localnet" : "Devnet"} <span className="text-green">✓</span></span></div>
      {enough === false && <p role="alert" className="pt-2 text-[13px] text-error">Add SOL to this wallet before starting; a launch left half-way costs deposits for nothing.</p>}
      {platform.config.isPaused && <p role="alert" className="pt-2 text-[13px] text-error">Aegis is paused and isn’t accepting new launches right now.</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Step 01: a new launch
// ------------------------------------------------------------------------------------------------

function NewLaunch({ platform }: { platform: Platform }) {
  const { publicKey } = useWallet();
  const navigate = useNavigate();
  const balance = useSol();
  const [draft, setDraft] = useState<AssetDraft>(EMPTY_ASSET);
  const signing = useSigning(() => {});
  const check = checkAsset(draft);
  const busy = signing.current !== null;
  const blocked = platform.config.isPaused || (balance.data !== undefined && balance.data < platform.config.creationFeeLamports + DEPOSITS_LAMPORTS);

  const create = async () => {
    if (!("details" in check) || !publicKey) return;
    const rwa = Keypair.generate();
    const specs: TxSpec[] = [{ id: "create", title: "Create the security", build: async () => ({ ixs: createInstructions(rwa.publicKey, publicKey, platform.config.feeRecipient, check.details), signers: [rwa] }) }];
    if (await signing.run(specs, async () => false)) navigate(`/launch/${rwa.publicKey.toBase58()}`, { replace: true });
  };

  const name = draft.name.trim() || "A new asset";
  return (
    <div className="grid grid-cols-1 gap-12 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_22rem]">
      <Rail name={name} detail={draft.symbol ? `${draft.symbol} · ${draft.supply || "—"} units` : "Not created yet"} states={{ asset: "now", compliance: "todo", escrow: "todo", terms: "todo", open: "todo" }} signed={0} />
      <Panel kicker="Step 01 of 05" title="The asset" intro="The security you are issuing. Its name, symbol and supply are written into the token itself, and you receive every legal power over it: Aegis holds none.">
        <AssetForm draft={draft} onChange={setDraft} disabled={busy} />
        <SigningError signing={signing} />
        <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-6">
          <button type="button" className={btn} disabled={!("details" in check) || busy || blocked} onClick={() => void create()}>
            {busy && signing.phase.kind === "busy" ? TX_STEP[signing.phase.step] : "Create the security · 1 signature"}
          </button>
          <span className="text-[13px] text-mute">Includes the {sol(platform.config.creationFeeLamports)} SOL platform fee.</span>
        </div>
      </Panel>
      <div className="lg:col-start-2 xl:col-start-3">
        <Costs platform={platform} balance={balance.data} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Steps 02–05: a launch in progress
// ------------------------------------------------------------------------------------------------

const draftKey = (mint: string) => `aegis.terms.${mint}`;
function loadDraft(mint: string): TermsDraft | null {
  try { const raw = localStorage.getItem(draftKey(mint)); return raw ? (JSON.parse(raw) as TermsDraft) : null; } catch { return null; }
}
function saveDraft(mint: string, d: TermsDraft) {
  try { localStorage.setItem(draftKey(mint), JSON.stringify(d)); } catch { /* per-viewer convenience only */ }
}

function Continue({ mint, platform }: { mint: PublicKey; platform: Platform }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const me = publicKey!;
  const key = mint.toBase58();
  const progress = useQuery({ queryKey: ["issue", config.rpcUrl, key, me.toBase58()], queryFn: () => loadIssueProgress(connection, mint, me), refetchInterval: config.refreshMs });
  const label = useQuery({
    queryKey: ["issue-label", config.rpcUrl, key],
    queryFn: async () => { const info = await connection.getAccountInfo(mint, "confirmed"); return info ? mintLabel(decodeMint(mint, info)) : null; },
  });
  const [terms, setTerms] = useState<TermsDraft | null>(() => loadDraft(key));
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState<{ busy: boolean; error: Explained | null }>({ busy: false, error: null });
  const signing = useSigning(() => void queryClient.invalidateQueries({ queryKey: ["issue"] }));

  useEffect(() => { if (terms) saveDraft(key, terms); }, [key, terms]);
  useEffect(() => { if (!terms && platform.quotes[0]) setTerms(defaultTerms(platform.config, platform.quotes[0])); }, [terms, platform]);

  const p = progress.data;
  if (!p) return progress.isError ? <p role="alert" className="text-error">This launch couldn’t be read. It retries automatically.</p> : <span aria-busy="true" className="h-64 animate-pulse bg-track/70" />;
  if (!p.launch) {
    return (
      <div className="flex flex-col items-start gap-3 border border-ink bg-surface p-8">
        <strong className="font-serif text-3xl font-normal">No launch at this address</strong>
        <p className="text-ink2">If you just created it, it appears within a few seconds.</p>
        <Link to="/launch" className="inline-flex min-h-11 items-center bg-blue px-5 text-sm font-semibold text-white">Start a new launch</Link>
      </div>
    );
  }
  const launch = p.launch;
  if (!launch.issuer.equals(me)) {
    return (
      <div className="flex flex-col items-start gap-3 border border-ink bg-surface p-8">
        <strong className="font-serif text-3xl font-normal">This launch belongs to another wallet</strong>
        <p className="text-ink2">Only its issuer, <span className="font-mono">{shortAddress(launch.issuer.toBase58())}</span>, can continue it.</p>
      </div>
    );
  }

  const name = label.data?.name || "Unnamed asset";
  const symbol = label.data?.symbol || "";
  const supply = formatUnits(launch.totalSupply, launch.decimals, { maxFraction: 0 });
  const signed = Object.values(p.done).filter(Boolean).length;

  if (p.aborted) {
    return (
      <div className="flex flex-col items-start gap-3 border border-ink bg-surface p-8">
        <span className="kicker">{name}</span>
        <strong className="font-serif text-4xl font-normal">This issuance was cancelled</strong>
        <p className="max-w-2xl text-ink2">The whole supply of {supply} {symbol} went back to your wallet, and no sale was ever opened.</p>
        <Link to="/launch" className="inline-flex min-h-11 items-center bg-blue px-5 text-sm font-semibold text-white">Start a new launch</Link>
      </div>
    );
  }
  if (p.next === null) {
    return (
      <div className="flex flex-col items-start gap-4 border border-ink bg-surface p-8">
        <span className="kicker text-green">All {TX_COUNT} signatures done</span>
        <strong className="font-serif text-5xl font-normal">{name} is open for sale</strong>
        <p className="max-w-2xl text-[17px] leading-relaxed text-ink2">Buyers can now trade <span className="font-mono">c{symbol}</span> on the curve. Every one of them is backed one for one by the {supply} {symbol} in escrow. You collect your raise from the console when the sale completes.</p>
        <div className="flex flex-wrap gap-3">
          <Link to={`/asset/${key}`} className="inline-flex min-h-12 items-center bg-blue px-5 font-semibold text-white">See your sale</Link>
          <Link to={`/console/${key}`} className="inline-flex min-h-12 items-center border border-ink px-5 font-semibold">Open the console</Link>
        </div>
      </div>
    );
  }

  const done = p.done;
  const termsFixed = done.terms;
  const result = terms ? readTerms(terms, platform.quotes, platform.config) : null;
  const wizardDone: Record<WizardId, boolean> = {
    asset: done.create,
    compliance: done.register && done.groups && done.vault && done.yourself,
    escrow: done.fund,
    terms: termsFixed || reviewing,
    open: done.open,
  };
  const now = WIZARD.find((w) => !wizardDone[w.id])!.id;
  const states = Object.fromEntries(WIZARD.map((w) => [w.id, wizardDone[w.id] ? "done" : w.id === now ? "now" : "todo"])) as Record<WizardId, "done" | "now" | "todo">;
  const isDone = async (id: StepId) => (await loadIssueProgress(connection, mint, me)).done[id];
  const a = issueAddresses(mint, me);
  const busy = signing.current !== null;

  const wrapperName = bytes(`Wrapped ${name}`) <= 32 ? `Wrapped ${name}` : name;
  const specs: Record<StepId, TxSpec> = {
    create: { id: "create", title: "Create the security", build: async () => ({ ixs: [] }) },
    register: { id: "register", title: "Set up your holder register", detail: "Upside’s register for the security, and the checks it runs on every transfer.", build: async () => ({ ixs: registerInstructions(mint, me) }) },
    groups: { id: "groups", title: "Add groups: Investors and Escrow", detail: "And the two rules between them: escrow → investors, and investors → escrow.", build: async () => ({ ixs: groupInstructions(mint, me) }) },
    vault: { id: "vault", title: "Register the escrow vault as a holder", detail: "In the Escrow group, which only the vault is in.", build: async () => ({ ixs: holderInstructions(mint, me, a.authority, VAULT_GROUP, await nextHolderIdFor(connection, mint)) }) },
    yourself: { id: "yourself", title: "Register yourself as a holder", detail: "So you can take back unsold stock later.", build: async () => ({ ixs: holderInstructions(mint, me, me, INVESTOR_GROUP, await nextHolderIdFor(connection, mint)) }) },
    fund: { id: "fund", title: `Mint all ${supply} ${symbol} into escrow`, detail: "From here, you can still cancel and take it back.", build: async () => ({ ixs: fundInstructions(mint, me) }) },
    terms: {
      id: "terms", title: "Fix the sale terms with Meteora", detail: "Written into a Meteora config that nobody can change afterwards.",
      build: async () => {
        if (!result?.ok) throw new Error("The sale terms are incomplete.");
        const cfg = Keypair.generate();
        return { ixs: termsInstructions(mint, me, result.quote.mint, cfg.publicKey, result.terms, launch.decimals), signers: [cfg] };
      },
    },
    open: {
      id: "open", title: "Open the sale", detail: "Point of no return: once buyers exist, the escrow backs their tokens.",
      build: async () => {
        const fresh = (await loadIssueProgress(connection, mint, me)).launch!;
        const quoteInfo = await connection.getAccountInfo(fresh.quoteMint, "confirmed");
        if (!quoteInfo) throw new Error("The sale currency couldn’t be read.");
        const crwa = Keypair.generate();
        return { ixs: openInstructions(fresh, me, crwa.publicKey, quoteInfo.owner, { name: wrapperName, symbol: `c${symbol}`, uri: "" }), signers: [crwa] };
      },
    },
  };
  const runStep = (ids: StepId[]) => void signing.run(ids.map((id) => specs[id]), isDone);
  const remaining = (ids: StepId[]) => ids.filter((id) => !done[id]).length;
  const signButton = (ids: StepId[], label: string) => (
    <button type="button" className={btn} disabled={busy || remaining(ids) === 0} onClick={() => runStep(ids)}>
      {busy && signing.phase.kind === "busy" ? TX_STEP[signing.phase.step] : label}
    </button>
  );

  const toReview = async () => {
    if (!result?.ok) return;
    setChecking({ busy: true, error: null });
    try {
      // Ask the program itself, without signing: the preview's maths is ours, the verdict is its.
      await prepareTransaction(connection, me, termsInstructions(mint, me, result.quote.mint, Keypair.generate().publicKey, result.terms, launch.decimals));
      setChecking({ busy: false, error: null });
      setReviewing(true);
    } catch (e) {
      setChecking({ busy: false, error: explainTradeError(e, ISSUE_ERRORS) });
    }
  };

  let body: ReactNode;
  if (now === "compliance") {
    const ids: StepId[] = ["register", "groups", "vault", "yourself"];
    body = (
      <Panel kicker="Step 02 of 05" title="Compliance" intro={<>Your security’s holder register lives in Upside’s compliance programs, and you control it. These four signatures create it, add the Investors and Escrow groups, and register the escrow vault and you as holders. Nobody outside the register can ever hold {symbol}.</>}>
        <TxList specs={ids.map((id) => specs[id])} done={done} signing={signing} />
        <SigningError signing={signing} />
        <div>{signButton(ids, `Sign ${remaining(ids)} ${remaining(ids) === 1 ? "transaction" : "transactions"}`)}</div>
      </Panel>
    );
  } else if (now === "escrow") {
    body = (
      <Panel kicker="Step 03 of 05" title="Escrow" intro={<>The whole supply of {supply} {symbol} is minted straight into a vault that Aegis controls and nobody can move by hand. This is what backs every wrapper one for one. Until the sale opens, you can cancel and take it all back.</>}>
        <TxList specs={[specs.fund]} done={done} signing={signing} />
        <SigningError signing={signing} />
        <div>{signButton(["fund"], "Mint into escrow · 1 signature")}</div>
      </Panel>
    );
  } else if (now === "terms" && terms) {
    body = (
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel kicker="Step 04 of 05" title="Sale terms" intro="Six questions. These terms are fixed once the sale opens, so the panel shows what each answer means before you commit.">
          <TermsForm draft={terms} onChange={setTerms} quotes={platform.quotes} platform={platform.config} disabled={checking.busy} />
        </Panel>
        <aside aria-label="What these terms mean" className="flex h-fit flex-col gap-4 border border-ink bg-surface p-6 xl:sticky xl:top-6">
          <div>
            <h2 className="text-[17px] font-semibold">What these terms mean</h2>
            <p className="text-[13px] text-mute">Recalculated as you type, with the same maths the protocol uses.</p>
          </div>
          {result && <TermsPreview result={result} platform={platform.config} totalSupply={launch.totalSupply} decimals={launch.decimals} symbol={symbol} curveFeeBps={platform.config.curveFeeBps} issuerCurveFeeSharePct={platform.config.issuerCurveFeeSharePct} />}
          {checking.error && (
            <div role="alert" className="border border-error p-3 text-sm"><strong className="text-error">{checking.error.title}.</strong> <span className="text-ink2">{checking.error.detail}</span></div>
          )}
          <button type="button" className={btn} disabled={!result?.ok || checking.busy} onClick={() => void toReview()}>{checking.busy ? "Checking with the protocol…" : "Continue to review"}</button>
          <p className="text-[13px] text-mute">Continuing asks the program whether it accepts these terms. Nothing is signed yet.</p>
        </aside>
      </div>
    );
  } else {
    body = <Review launchSymbol={symbol} name={name} supply={supply} wrapperName={wrapperName} result={result} termsFixed={termsFixed} meteoraConfig={launch.meteoraConfig}
      quote={platform.quotes.find((x) => x.mint.equals(launch.quoteMint))} decimals={launch.decimals}
      onBack={termsFixed ? undefined : () => setReviewing(false)}>
      <TxList specs={[specs.terms, specs.open]} done={done} signing={signing} />
      <SigningError signing={signing} />
      <div>{signButton(["terms", "open"], termsFixed ? "Open the sale · 1 signature" : "Sign 2 transactions and open the sale")}</div>
    </Review>;
  }

  return (
    <div className="grid grid-cols-1 gap-12 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)]">
      <Rail name={name} detail={`${symbol} · ${supply} units`} states={states} signed={signed} />
      <div className="flex min-w-0 flex-col gap-10">
        {body}
        {(launch.stage === "Funded" || launch.stage === "Configured") && done.yourself && <Cancel launch={p.launch} supply={supply} symbol={symbol} />}
      </div>
    </div>
  );
}

function Review({ name, launchSymbol, supply, wrapperName, result, termsFixed, meteoraConfig, quote, decimals, onBack, children }: {
  name: string; launchSymbol: string; supply: string; wrapperName: string; result: ReturnType<typeof readTerms> | null; termsFixed: boolean;
  meteoraConfig: PublicKey; quote: Platform["quotes"][number] | undefined; decimals: number; onBack?: () => void; children: ReactNode;
}) {
  const { connection } = useConnection();
  // Once fixed, the terms shown are the ones Meteora stored, never the draft.
  const stored = useQuery({
    queryKey: ["issue-config", config.rpcUrl, meteoraConfig.toBase58()],
    enabled: termsFixed,
    queryFn: async () => { const info = await connection.getAccountInfo(meteoraConfig, "confirmed"); return info ? decodeDbcConfig(info) : null; },
  });
  const row = (k: string, v: ReactNode) => <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-4 border-b border-rule py-3 text-sm"><span className="text-ink2">{k}</span><span className="num">{v}</span></div>;
  const q = (v: bigint, cur: { decimals: number; symbol: string }) => `${formatUnits(v, cur.decimals, { maxFraction: 4, minFraction: 2 })} ${cur.symbol}`;
  let terms: ReactNode = null;
  if (termsFixed) {
    const c = stored.data;
    terms = c && quote ? (
      <>
        {row("Opening price", q(sqrtPriceToQuoteAtoms(c.sqrtStartPrice, decimals), quote))}
        {row("Sale closes at", q(sqrtPriceToQuoteAtoms(c.migrationSqrtPrice, decimals), quote))}
        {row("Raise", q(c.migrationQuoteThreshold, quote))}
        {row("Cash to you", `${c.migrationFeePct}% of the raise, of which ${c.creatorMigrationFeePct}% is yours`)}
        {row("Pool trading fee", `${(c.migratedPoolFeeBps / 100).toFixed(2)}%`)}
      </>
    ) : <span aria-busy="true" className="h-24 animate-pulse bg-track/70" />;
  } else if (result?.ok) {
    const { terms: tt, quote: cur } = result;
    terms = (
      <>
        {row("Opening price", q(tt.quoteAtomsPerToken, cur))}
        {row("Price may rise to", `${priceMultiple(tt.sqrtBps).toFixed(2)}× the opening price`)}
        {row("Raise", q(tt.targetRaise, cur))}
        {row("Cash to you", `${tt.migrationFeePct}% of the raise`)}
        {row("Your pool share", `${tt.permanentPct}% locked forever · ${tt.vestedPct}% unlocks${tt.vestedPct ? ` over ${tt.vestingMonths} months` : ""}`)}
        {row("Pool trading fee", `${(tt.poolFeeBps / 100).toFixed(2)}%`)}
      </>
    );
  }
  return (
    <Panel kicker="Step 05 of 05" title="Review & open" intro={termsFixed ? "Your terms are fixed with Meteora, exactly as shown. One signature opens the sale." : "Check everything once more. The first signature fixes these terms for good; the second opens the sale."}>
      <div className="flex flex-col">
        {row("Security", <>{name} · <span className="font-mono">{launchSymbol}</span> · {supply} units</>)}
        {row("Tradable wrapper", <>{wrapperName} · <span className="font-mono">c{launchSymbol}</span>, backed 1 : 1</>)}
        {terms}
      </div>
      {children}
      {onBack && <button type="button" onClick={onBack} className="w-fit cursor-pointer text-sm text-ink2 underline underline-offset-4 hover:text-ink">← Change the terms</button>}
    </Panel>
  );
}

function Cancel({ launch, supply, symbol }: { launch: NonNullable<IssueProgress["launch"]>; supply: string; symbol: string }) {
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const tx = useTxRunner(ISSUE_ERRORS);
  const busy = tx.phase.kind === "busy";
  return (
    <div className="border-t border-rule pt-6">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="cursor-pointer text-sm text-error underline underline-offset-4">Cancel the issuance and return the escrow</button>
      ) : (
        <div role="group" aria-label="Cancel the issuance" className="flex max-w-2xl flex-col gap-3 border border-error bg-surface p-5">
          <strong>Cancel this issuance for good?</strong>
          <p className="text-sm leading-relaxed text-ink2">All {supply} {symbol} leave escrow and come back to your wallet, and this launch ends. It can’t be reopened; you would start a new one.</p>
          {tx.phase.kind === "failed" && <p role="alert" className="text-sm"><strong className="text-error">{tx.phase.error.title}.</strong> {tx.phase.error.detail}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => void tx.run(() => abortInstructions(launch, publicKey!))} className="min-h-11 cursor-pointer bg-error px-5 text-sm font-semibold text-white disabled:opacity-50">{busy && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : "Cancel the issuance"}</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-11 cursor-pointer border border-line px-5 text-sm hover:border-ink">Keep going</button>
          </div>
        </div>
      )}
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
      <div className="flex max-w-3xl flex-col items-start gap-4">
        <span className="kicker">Launch an asset</span>
        <h1 className="font-serif text-6xl leading-[0.98]">Issue a real asset on Aegis</h1>
        <p className="text-lg leading-relaxed text-ink2">Five steps and eight signatures: create the security, set up its holder register, lock the supply in escrow, choose the sale terms, and open the sale. Every step is saved on-chain as you go.</p>
        <button type="button" onClick={openConnect} className={btn}>Connect the wallet you will issue from</button>
      </div>
    );
  }
  if (parsed === undefined) return shell(<p className="text-error">That link isn’t a valid asset address.</p>);
  if (!platform.data) {
    return shell(platform.isError
      ? <div role="alert" className="border border-error bg-surface p-6"><strong>Aegis couldn’t be read on this network.</strong> <span className="text-ink2">{String((platform.error as Error)?.message ?? "")}</span></div>
      : <span aria-busy="true" className="h-64 animate-pulse bg-track/70" />);
  }
  if (platform.data.quotes.length === 0) return shell(<p role="alert" className="text-error">No sale currency is approved on this network yet, so launches can’t be opened.</p>);
  return shell(parsed ? <Continue mint={parsed} platform={platform.data} /> : <NewLaunch platform={platform.data} />);
}
