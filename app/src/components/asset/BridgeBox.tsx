import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { explorerUrl } from "../../config";
import { loadAsset } from "../../chain/asset";
import { loadBridgeStatus, prepareBridge, type BridgeBlock, type Direction } from "../../chain/bridge";
import type { RegistryEntry } from "../../chain/registry";
import { useBridgeStatus } from "../../hooks/useBridgeStatus";
import { formatUnits, parseUnits, toInputText } from "../../lib/amount";
import { explainTradeError, type Explained } from "../../lib/txErrors";
import { useConnectModal } from "../connect/ConnectModal";
import { Hint } from "../Hint";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "signing" | "confirming" }
  | { kind: "done"; direction: Direction; amount: string; signature: string }
  | { kind: "failed"; error: Explained };

const STEP = { checking: "Checking…", signing: "Approve in your wallet…", confirming: "Confirming…" } as const;

/** Maps a pre-check result onto the program's error name, so both paths share one explanation. */
const CODE: Record<BridgeBlock["kind"], string> = {
  "not-graduated": "InvalidLaunchStage", paused: "TransfersPaused", "not-approved": "HolderNotApproved", frozen: "VaultFrozen",
  "vault-unavailable": "BackingShortfall", "deposit-closed": "DepositPathClosed", "deposit-locked": "DepositPathLocked",
};

function blockLine(block: BridgeBlock, sym: string, wsym: string): string {
  switch (block.kind) {
    case "not-approved": return `Your wallet isn’t approved to hold ${sym} yet.`;
    case "paused": return `The issuer has paused ${sym} transfers.`;
    case "frozen": return `Your ${sym} account is frozen by the issuer.`;
    case "vault-unavailable": return "The escrow is unavailable; exchanges are stopped for everyone.";
    case "deposit-closed": return `Exchanging ${sym} back into ${wsym} is closed.`;
    case "deposit-locked": return `Exchanging back opens ${block.until.toLocaleDateString()}.`;
    case "not-graduated": return "Opens when the sale completes.";
  }
}

/** Redeem the wrapper for the security, or deposit it back: 1 : 1, no fee. Lives in the asset page's action box. */
export function BridgeBox({ entry }: { entry: RegistryEntry }) {
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
  const [copied, setCopied] = useState(false);

  const d = launch.decimals;
  const sym = entry.label?.symbol ?? "security";
  const wsym = entry.wrapperLabel?.symbol ?? "wrapper";
  const [fromSym, toSym] = direction === "redeem" ? [wsym, sym] : [sym, wsym];
  const s = status.data;
  const block: BridgeBlock | null = entry.backing.kind === "short" ? { kind: "vault-unavailable" } : s ? s[direction] : null;
  const have = s ? (direction === "redeem" ? s.wrapper : s.security) : 0n;
  const max = s ? (direction === "redeem" ? (s.wrapper < s.escrowed ? s.wrapper : s.escrowed) : s.security) : 0n;
  const parsed = parseUnits(text, d);
  const busy = phase.kind === "busy";
  const fmt = (v: bigint) => formatUnits(v, d, { maxFraction: 4 });

  let problem: string | null = null;
  if (text && !parsed.ok) problem = parsed.reason;
  else if (parsed.ok && s && parsed.atoms > have) problem = `You have ${fmt(have)} ${fromSym}.`;
  else if (parsed.ok && s && direction === "redeem" && parsed.atoms > s.escrowed) problem = `The escrow holds ${fmt(s.escrowed)} ${sym}.`;

  useEffect(() => setPhase((p) => (p.kind === "failed" ? { kind: "idle" } : p)), [text, direction]);

  async function submit() {
    if (!publicKey || !parsed.ok || problem || block || inFlight.current) return;
    inFlight.current = true;
    try {
      // Re-check against a fresh read, so a pause or revoked approval since the page opened is
      // explained here rather than by a failed transaction.
      setPhase({ kind: "busy", step: "checking" });
      const fresh = await loadAsset(connection, launch.realRwaMint);
      const now = await loadBridgeStatus(connection, fresh.launch, publicKey);
      if (now[direction]) throw Object.assign(new Error("blocked"), { logs: [`Error Code: ${CODE[now[direction]!.kind]}`] });
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
      for (const key of ["bridge", "asset", "registry", "holdings"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }

  return (
    <section aria-label={`Exchange ${wsym} and ${sym}`} className="flex flex-col border border-ink bg-surface">
      <div role="tablist" aria-label="Direction" className="grid grid-cols-2 border-b border-ink">
        {([["redeem", "Redeem"], ["deposit", "Deposit"]] as const).map(([dir, label]) => (
          <button key={dir} role="tab" type="button" aria-selected={direction === dir} disabled={busy} onClick={() => { setDirection(dir); setText(""); setPhase({ kind: "idle" }); }}
            className={`min-h-12 cursor-pointer text-[15px] ${direction === dir ? "-mb-px border-b-2 border-ink font-semibold" : "text-mute hover:text-ink"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4 p-5">
        {phase.kind === "done" ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="kicker text-green">Exchanged</span>
            <span className="font-serif text-4xl leading-tight">{phase.amount} {phase.direction === "redeem" ? sym : wsym}</span>
            <a href={explorerUrl("tx", phase.signature)} target="_blank" rel="noopener noreferrer" className="w-fit text-sm text-blue underline underline-offset-2">View the transaction ↗</a>
            <button type="button" onClick={() => setPhase({ kind: "idle" })} className="mt-1 min-h-12 cursor-pointer border border-ink font-semibold hover:bg-paper">Exchange more</button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <label htmlFor={inputId} className="text-sm font-semibold">You give</label>
                <span className="font-mono text-xs text-mute">{publicKey && s ? `Balance ${fmt(have)}` : ""}</span>
              </div>
              <div className={`flex h-14 items-center border bg-paper px-3 ${problem ? "border-error" : "border-ink"}`}>
                <input id={inputId} inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={busy}
                  onChange={(e) => setText(e.target.value.slice(0, 32))} aria-invalid={Boolean(problem)} aria-describedby={`${inputId}-hint`}
                  className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-line num" />
                <button type="button" disabled={busy || !s || max === 0n} onClick={() => setText(toInputText(max, d))} className="min-h-9 cursor-pointer px-1 text-[13px] font-semibold text-blue disabled:cursor-not-allowed disabled:opacity-40">Max</button>
                <span className="ml-2 font-mono text-sm">{fromSym}</span>
              </div>
              <p id={`${inputId}-hint`} className="min-h-5 text-[13px] text-error" aria-live="polite">{problem ?? ""}</p>
            </div>
            <div className="flex items-baseline justify-between border-t border-rule pt-3 text-sm">
              <span className="text-ink2">You receive</span>
              <span className="font-serif text-2xl num">{parsed.ok ? fmt(parsed.atoms) : "0"} <span className="font-mono text-xs text-mute">{toSym}</span></span>
            </div>
            <p className="flex items-center gap-1 font-mono text-xs text-mute">
              1 : 1 · no fee · no price impact
              <Hint>Each {wsym} is backed by one {sym} held in escrow. {sym} is a regulated security: only wallets the issuer has approved can hold it. {wsym} needs no approval.</Hint>
            </p>

            {publicKey && block && (
              <div role="status" className="flex flex-col gap-2 border-l-2 border-amber pl-3 text-[13px] leading-relaxed">
                <span>{blockLine(block, sym, wsym)}</span>
                {block.kind === "not-approved" && (
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(publicKey.toBase58()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
                    className="w-fit cursor-pointer font-semibold text-blue underline underline-offset-2">{copied ? "Copied" : "Copy your address for the issuer"}</button>
                )}
              </div>
            )}
            {phase.kind === "failed" && (
              <p role="alert" className="text-[13px] leading-relaxed"><strong className="text-error">{phase.error.title}.</strong> <span className="text-ink2">{phase.error.detail}</span></p>
            )}
            {!publicKey ? (
              <button type="button" onClick={openConnect} className="min-h-12 cursor-pointer bg-ink font-semibold text-paper">Connect wallet</button>
            ) : (
              <button type="button" onClick={() => void submit()} disabled={busy || !parsed.ok || Boolean(problem) || Boolean(block) || !s}
                className="min-h-12 cursor-pointer bg-blue font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40">
                {busy ? STEP[phase.step] : direction === "redeem" ? `Redeem for ${sym}` : `Deposit for ${wsym}`}
              </button>
            )}
            {status.isError && <p role="alert" className="text-[13px] text-error">Your balances couldn’t be read. It retries automatically.</p>}
          </>
        )}
      </div>
    </section>
  );
}
