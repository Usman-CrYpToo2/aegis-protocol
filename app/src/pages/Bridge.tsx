import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { loadAsset, AssetNotFoundError } from "../chain/asset";
import { loadBridgeStatus, prepareBridge, type BridgeBlock, type Direction } from "../chain/bridge";
import type { RegistryEntry } from "../chain/registry";
import { useConnectModal } from "../components/connect/ConnectModal";
import { useAsset } from "../hooks/useAsset";
import { useBridgeStatus } from "../hooks/useBridgeStatus";
import { formatUnits, parseUnits, shortAddress, toInputText } from "../lib/amount";
import { explainTradeError, type Explained } from "../lib/txErrors";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "signing" | "confirming" }
  | { kind: "done"; direction: Direction; amount: string; signature: string }
  | { kind: "failed"; error: Explained };

const STEP = { checking: "Checking the bridge…", signing: "Approve in your wallet…", confirming: "Confirming on-chain…" } as const;

// ------------------------------------------------------------------------------------------------
// What stops this wallet, said plainly, with what to do next.
// ------------------------------------------------------------------------------------------------

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 border border-line bg-white px-3 py-2">
      <span className="font-mono text-[13px] break-all">{address}</span>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined)}
        className="min-h-9 shrink-0 cursor-pointer text-[13px] font-semibold text-blue"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function BlockNotice({ block, address, sym, wsym, mint }: { block: BridgeBlock; address: string; sym: string; wsym: string; mint: string }) {
  const box = (tone: "amber" | "error", title: string, body: ReactNode) => (
    <div role="status" className={`flex flex-col gap-2 border bg-surface p-5 ${tone === "error" ? "border-error" : "border-amber"}`}>
      <strong className={`text-[15px] ${tone === "error" ? "text-error" : "text-ink"}`}>{title}</strong>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink2">{body}</div>
    </div>
  );
  switch (block.kind) {
    case "not-approved":
      return box("amber", "Your wallet is not approved yet", <>
        <span>You can keep holding and trading {wsym}. To hold {sym} itself, the issuer must add your wallet to its register after checking who you are. Send them this address:</span>
        <CopyAddress address={address} />
        <span className="text-mute">This page updates by itself once you are approved.</span>
      </>);
    case "paused":
      return box("amber", "The issuer has paused transfers", <span>Every transfer of {sym} is stopped, so the bridge is waiting. Your {wsym} still trades freely and your backing is untouched. This lifts when the issuer resumes transfers.</span>);
    case "frozen":
      return box("error", "Your security account is frozen", <span>The issuer has frozen your {sym} account, so it can’t send or receive. Contact the issuer; Aegis can’t lift this.</span>);
    case "vault-unavailable":
      return box("error", "The escrow is unavailable", <span>The escrow or its registration has changed, so the bridge has stopped to protect every holder equally. <Link to={`/asset/${mint}#proof`} className="text-blue underline underline-offset-2">See the proof</Link>.</span>);
    case "deposit-closed":
      return box("amber", "The route back into the wrapper is closed", <span>You can still exchange {wsym} for {sym}. Going the other way needs the issuer to open it.</span>);
    case "deposit-locked":
      return box("amber", "The route back into the wrapper opens later", <span>The issuer’s rule keeps it locked until {block.until.toLocaleString()}. You can still exchange {wsym} for {sym} now.</span>);
    case "not-graduated":
      return box("amber", "The bridge opens at graduation", <span>While the offering is open, the wrapper trades on the sale curve. <Link to={`/asset/${mint}`} className="text-blue underline underline-offset-2">Back to the offering</Link>.</span>);
  }
}

// ------------------------------------------------------------------------------------------------
// The exchange
// ------------------------------------------------------------------------------------------------

function Gate({ entry }: { entry: RegistryEntry }) {
  const { launch } = entry;
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { open: openConnect } = useConnectModal();
  const queryClient = useQueryClient();
  const status = useBridgeStatus(launch);
  const inputId = useId();
  const inFlight = useRef(false);

  const [direction, setDirection] = useState<Direction>("redeem");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const d = launch.decimals;
  const sym = entry.label?.symbol ?? "security";
  const wsym = entry.wrapperLabel?.symbol ?? "wrapper";
  const [fromSym, toSym] = direction === "redeem" ? [wsym, sym] : [sym, wsym];
  const s = status.data;
  const shortBacking = entry.backing.kind === "short";
  const block: BridgeBlock | null = shortBacking ? { kind: "vault-unavailable" } : s ? s[direction] : null;
  const have = s ? (direction === "redeem" ? s.wrapper : s.security) : 0n;
  const max = s ? (direction === "redeem" ? (s.wrapper < s.escrowed ? s.wrapper : s.escrowed) : s.security) : 0n;
  const parsed = parseUnits(text, d);
  const busy = phase.kind === "busy";
  const fmt = (v: bigint) => formatUnits(v, d, { maxFraction: d });

  let problem: string | null = null;
  if (text && !parsed.ok) problem = parsed.reason;
  else if (parsed.ok && s && parsed.atoms > have) problem = `You have ${fmt(have)} ${fromSym}.`;
  else if (parsed.ok && s && direction === "redeem" && parsed.atoms > s.escrowed) problem = `The escrow holds ${fmt(s.escrowed)} ${sym}.`;

  useEffect(() => setPhase((p) => (p.kind === "failed" ? { kind: "idle" } : p)), [text, direction]);

  async function submit() {
    if (!publicKey || !parsed.ok || problem || block || inFlight.current) return;
    inFlight.current = true;
    try {
      // Re-check eligibility against a fresh read, so a pause or revoked approval that happened
      // while the page was open is explained here rather than by a failed transaction.
      setPhase({ kind: "busy", step: "checking" });
      const fresh = await loadAsset(connection, launch.realRwaMint);
      const now = await loadBridgeStatus(connection, fresh.launch, publicKey);
      if (now[direction]) throw Object.assign(new Error("blocked"), { logs: [`Error Code: ${blockToCode(now[direction]!)}`] });
      const prepared = await prepareBridge(connection, direction, fresh.launch, publicKey, parsed.atoms);
      setPhase({ kind: "busy", step: "signing" });
      const signature = await sendTransaction(prepared.transaction, connection, { preflightCommitment: "confirmed" });
      setPhase({ kind: "busy", step: "confirming" });
      const result = await connection.confirmTransaction({ signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, "confirmed");
      if (result.value.err) {
        const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        throw Object.assign(new Error(JSON.stringify(result.value.err)), { logs: tx?.meta?.logMessages ?? [] });
      }
      setPhase({ kind: "done", direction, amount: fmt(parsed.atoms), signature });
      setText("");
    } catch (e) {
      setPhase({ kind: "failed", error: explainTradeError(e) });
    } finally {
      inFlight.current = false;
      void queryClient.invalidateQueries({ queryKey: ["bridge"] });
      void queryClient.invalidateQueries({ queryKey: ["asset"] });
      void queryClient.invalidateQueries({ queryKey: ["registry"] });
    }
  }

  const side = (label: string, symbol: string, amount: bigint | undefined, note: string) => (
    <div className="flex flex-col gap-3 border border-ink bg-surface p-6 lg:p-8">
      <div className="flex items-center justify-between"><span className="kicker">{label}</span><span className="font-mono text-[13px]">{symbol}</span></div>
      <span className="font-serif text-5xl leading-none num">{!publicKey ? "—" : amount === undefined ? "…" : fmt(amount)}</span>
      <span className="text-sm leading-relaxed text-ink2">{note}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Exchange" className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)_minmax(0,1fr)]">
        {side("The security", sym, s?.security, "You own this directly. It is a regulated security: it can only move between wallets the issuer has approved.")}
        <div className="order-first flex flex-col gap-4 bg-ink p-6 text-paper lg:order-none lg:p-7">
          {phase.kind === "done" ? (
            <div role="status" className="flex flex-col gap-3">
              <span className="kicker text-[#6FCF97]">Exchange complete</span>
              <span className="font-serif text-4xl leading-tight">{phase.amount} {phase.direction === "redeem" ? sym : wsym}</span>
              <span className="text-sm text-line">is now in your wallet, one for one, with no fee.</span>
              <a href={explorerUrl("tx", phase.signature)} target="_blank" rel="noopener noreferrer" className="w-fit text-sm text-paper underline underline-offset-2">View the transaction ↗</a>
              <button type="button" onClick={() => setPhase({ kind: "idle" })} className="mt-2 min-h-12 cursor-pointer bg-paper font-semibold text-ink">Exchange more</button>
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Direction" className="grid grid-cols-2 border border-mute">
                {([["redeem", `← Get ${sym}`], ["deposit", `Get ${wsym} →`]] as const).map(([dir, label]) => (
                  <button key={dir} role="tab" type="button" aria-selected={direction === dir} disabled={busy} onClick={() => { setDirection(dir); setText(""); }}
                    className={`min-h-11 cursor-pointer text-sm ${direction === dir ? "bg-paper font-semibold text-ink" : "text-line hover:text-paper"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <label htmlFor={inputId} className="text-sm text-line">Amount of {fromSym} to exchange</label>
              <div className={`flex h-16 items-center border-b ${problem ? "border-[#E8B4A8]" : "border-paper"}`}>
                <input id={inputId} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={busy}
                  onChange={(e) => setText(e.target.value.slice(0, 32))} aria-invalid={Boolean(problem)} aria-describedby={`${inputId}-hint`}
                  className="w-full bg-transparent font-serif text-4xl text-paper outline-none placeholder:text-mute num" />
                <button type="button" disabled={busy || !s || max === 0n} onClick={() => setText(toInputText(max, d))} className="min-h-10 cursor-pointer text-[13px] font-semibold text-paper underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40">Max</button>
              </div>
              <p id={`${inputId}-hint`} className={`min-h-5 text-[13px] ${problem ? "text-[#E8B4A8]" : "text-line"}`} aria-live="polite">{problem ?? ""}</p>
              <div className="flex items-center justify-center gap-3 py-1 font-mono text-[13px]">
                <span className="text-line">{parsed.ok ? fmt(parsed.atoms) : "0"} {fromSym}</span>
                <svg width="48" height="14" viewBox="0 0 48 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M0 7h46M40 1l6 6-6 6" /></svg>
                <span>{parsed.ok ? fmt(parsed.atoms) : "0"} {toSym}</span>
              </div>
              <p className="text-center font-mono text-xs text-line">1 : 1 · no fee · no price impact</p>
              {phase.kind === "failed" && (
                <div role="alert" className="border border-[#E8B4A8] p-3 text-[13px] leading-relaxed">
                  <strong className="block text-[#E8B4A8]">{phase.error.title}</strong>
                  <span className="text-line">{phase.error.detail}</span>
                </div>
              )}
              {!publicKey ? (
                <button type="button" onClick={openConnect} className="mt-auto min-h-14 cursor-pointer bg-paper font-semibold text-ink">Connect a wallet to exchange</button>
              ) : (
                <button type="button" onClick={() => void submit()} disabled={busy || !parsed.ok || Boolean(problem) || Boolean(block) || !s}
                  className="mt-auto min-h-14 cursor-pointer bg-paper font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40">
                  {busy ? STEP[phase.step] : parsed.ok && !problem && !block ? `Exchange ${fmt(parsed.atoms)} ${fromSym}` : direction === "redeem" ? `Get ${sym}` : `Get ${wsym}`}
                </button>
              )}
              <p className="sr-only" aria-live="assertive">{busy ? STEP[phase.step] : ""}</p>
            </>
          )}
        </div>
        {side("The wrapper", wsym, s?.wrapper, `Anyone can hold and trade it, no approval needed. Each one is backed by one ${sym} in escrow.`)}
      </section>

      {publicKey && block && <BlockNotice block={block} address={publicKey.toBase58()} sym={sym} wsym={wsym} mint={launch.realRwaMint.toBase58()} />}
      {status.isError && <p role="alert" className="text-sm text-error">Your bridge status couldn’t be read. {explainTradeError(status.error).detail}</p>}
    </div>
  );
}

/** Maps a pre-check result onto the program's error name, so both paths share one explanation. */
function blockToCode(block: BridgeBlock): string {
  return {
    "not-graduated": "InvalidLaunchStage",
    paused: "TransfersPaused",
    "not-approved": "HolderNotApproved",
    frozen: "VaultFrozen",
    "vault-unavailable": "BackingShortfall",
    "deposit-closed": "DepositPathClosed",
    "deposit-locked": "DepositPathLocked",
  }[block.kind];
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function BridgePage() {
  const { mint } = useParams();
  const asset = useAsset(mint);
  const entry = asset.data;

  useEffect(() => {
    document.title = entry?.label?.name ? `Bridge · ${entry.label.name} — Aegis` : "Bridge — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, [entry?.label?.name]);

  if (!entry) {
    if (asset.isPending) return <div className="shell pt-10 pb-24"><span className="block h-16 w-1/2 animate-pulse bg-track" aria-busy="true" aria-label="Loading the bridge" /></div>;
    return (
      <div className="shell flex flex-col gap-4 py-20">
        <h1 className="font-serif text-5xl">{asset.error instanceof AssetNotFoundError ? "Not in the registry" : "Can’t reach the network"}</h1>
        <p className="max-w-2xl text-lg text-ink2">{asset.error instanceof AssetNotFoundError ? "There is no bridge for this address." : `The bridge is read from ${config.rpcUrl}, which isn’t answering.`}</p>
        <Link to="/" className="inline-flex min-h-12 w-fit items-center bg-blue px-5 font-semibold text-white">Back to the registry</Link>
      </div>
    );
  }

  const name = entry.label?.name || "Unnamed asset";
  const mintStr = entry.launch.realRwaMint.toBase58();
  const open = entry.launch.stage === "Graduated";

  return (
    <div className="shell flex flex-col gap-8 pt-8 pb-24 lg:pt-10">
      <div className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="font-mono text-[13px] text-mute">
          <Link to="/" className="underline decoration-line underline-offset-2 hover:text-ink">Registry</Link> /{" "}
          <Link to={`/asset/${mintStr}`} className="underline decoration-line underline-offset-2 hover:text-ink">{name}</Link> / <span aria-current="page">Bridge</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-3">
            <h1 className="font-serif text-6xl leading-none">The bridge</h1>
            <p className="max-w-3xl text-lg leading-relaxed text-ink2">Exchange the wrapper for the security, or back, one for one. No fee, no price impact, open permanently since graduation.</p>
          </div>
          <span className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] ${open ? "border-green text-green" : "border-line text-mute"}`}>
            {open ? "✓ Graduated · bridge open" : "Opens at graduation"}
          </span>
        </div>
      </div>
      <Gate entry={entry} />
      <p className="text-[13px] text-mute">Escrow <a href={explorerUrl("address", entry.launch.escrowVault.toBase58())} target="_blank" rel="noopener noreferrer" className="font-mono underline underline-offset-2">{shortAddress(entry.launch.escrowVault.toBase58())}</a> · every exchange ends by checking the escrow still covers every wrapper.</p>
    </div>
  );
}
