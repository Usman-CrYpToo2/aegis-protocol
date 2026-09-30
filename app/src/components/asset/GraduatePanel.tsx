import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { useState } from "react";
import { loadAsset } from "../../chain/asset";
import { finalizeInstruction, graduationStep, migrateInstruction } from "../../chain/graduate";
import type { RegistryEntry } from "../../chain/registry";
import { TX_STEP, useTxRunner } from "../../hooks/useTxRunner";
import { useConnectModal } from "../connect/ConnectModal";

/**
 * A filled sale waits here until someone finishes it. Both transactions are open to anyone, so
 * this panel is shown to every visitor: a buyer, the issuer, or anyone passing by.
 */
export function GraduatePanel({ entry, tone = "light" }: { entry: RegistryEntry; tone?: "light" | "plain" }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const tx = useTxRunner();
  const [at, setAt] = useState<"migrate" | "finalize" | null>(null);
  const step = graduationStep(entry.launch, entry.detail.pool, entry.detail.terms);
  if (step !== "migrate" && step !== "finalize") return null;
  const wrapper = entry.wrapperLabel?.symbol ?? "the wrapper";
  const busy = tx.phase.kind === "busy";
  const signatures = step === "migrate" ? 2 : 1;

  const graduate = async () => {
    const mint = entry.launch.realRwaMint;
    // Re-read before each step: someone else may have sent it a moment ago.
    let fresh = await loadAsset(connection, mint);
    if (graduationStep(fresh.launch, fresh.detail.pool, fresh.detail.terms) === "migrate") {
      setAt("migrate");
      const quoteProgram = (await connection.getAccountInfo(fresh.launch.quoteMint, "confirmed"))?.owner;
      if (!quoteProgram) return;
      const nfts = [Keypair.generate(), Keypair.generate()];
      const ok = await tx.run(() => [migrateInstruction(fresh.launch, publicKey!, nfts[0]!.publicKey, nfts[1]!.publicKey, quoteProgram)], nfts);
      if (!ok) { setAt(null); return; }
      fresh = await loadAsset(connection, mint);
    }
    if (graduationStep(fresh.launch, fresh.detail.pool, fresh.detail.terms) === "finalize") {
      setAt("finalize");
      await tx.run(() => [finalizeInstruction(fresh.launch, publicKey!)]);
    }
    setAt(null);
  };

  const box = tone === "light" ? "border border-green bg-surface" : "border border-ink bg-surface";
  return (
    <div role="region" aria-label="Graduate this sale" className={`flex flex-col gap-3 p-5 ${box}`}>
      <span className="kicker text-green">Sale filled · one step left</span>
      <strong className="font-serif text-3xl leading-tight font-normal">Graduate it to open the bridge.</strong>
      <p className="text-sm leading-relaxed text-ink2">
        The raise is complete and trading on the curve has closed. Two things finish it: Meteora moves the raise into a permanent trading pool, and Aegis records the graduation, which opens the bridge between {wrapper} and the security.
        {" "}<strong>Anyone can do this</strong>; whoever does pays only the new accounts’ small deposits.
      </p>
      <ol className="flex flex-col border-t border-rule text-sm">
        <li className="flex justify-between gap-3 border-b border-rule py-2">
          <span>1 · Move to the permanent Meteora pool</span>
          <span className={step === "finalize" ? "text-green" : at === "migrate" && busy ? "text-blue" : "text-mute"}>{step === "finalize" ? "Done" : at === "migrate" && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : "Waiting"}</span>
        </li>
        <li className="flex justify-between gap-3 border-b border-rule py-2">
          <span>2 · Open the bridge</span>
          <span className={at === "finalize" && busy ? "text-blue" : "text-mute"}>{at === "finalize" && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : "Waiting"}</span>
        </li>
      </ol>
      {tx.phase.kind === "failed" && (
        <p role="alert" className="text-sm leading-relaxed"><strong className="text-error">{tx.phase.error.title}.</strong> <span className="text-ink2">{tx.phase.error.detail}</span></p>
      )}
      {publicKey ? (
        <button type="button" disabled={busy} onClick={() => void graduate()} className="min-h-12 cursor-pointer bg-blue px-5 font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40">
          {busy && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : `Graduate this sale · ${signatures} ${signatures === 1 ? "signature" : "signatures"}`}
        </button>
      ) : (
        <button type="button" onClick={openConnect} className="min-h-12 cursor-pointer bg-ink px-5 font-semibold text-paper">Connect a wallet to graduate it</button>
      )}
    </div>
  );
}
