import type { Keypair, TransactionInstruction } from "@solana/web3.js";
import { useState } from "react";
import { explorerUrl } from "../../config";
import type { StepId } from "../../chain/issue";
import { TX_STEP, useTxRunner } from "../../hooks/useTxRunner";
import { shortAddress } from "../../lib/amount";
import { ISSUE_ERRORS } from "../../lib/txErrors";

export type TxSpec = {
  id: StepId;
  title: string;
  detail?: string;
  /** Built at the moment of sending, from fresh chain state. */
  build: () => Promise<{ ixs: TransactionInstruction[]; signers?: Keypair[] }>;
};

/**
 * Signs a step's transactions in order, one wallet prompt each. Before each one it re-reads the
 * chain (`isDone`), so nothing is ever signed twice, even after a reload or a rejected prompt.
 */
export function useSigning(onLanded: (id: StepId, signature: string) => void) {
  const tx = useTxRunner(ISSUE_ERRORS);
  const [current, setCurrent] = useState<StepId | null>(null);
  const [signatures, setSignatures] = useState<Partial<Record<StepId, string>>>({});

  const run = async (specs: TxSpec[], isDone: (id: StepId) => Promise<boolean>) => {
    for (const spec of specs) {
      if (await isDone(spec.id)) continue;
      setCurrent(spec.id);
      // Built once, just before sending: a fresh keypair (a mint, a config) must sign the same
      // transaction it appears in.
      let built: Awaited<ReturnType<TxSpec["build"]>>;
      try {
        built = await spec.build();
      } catch (e) {
        await tx.run(() => { throw e; });
        setCurrent(null);
        return false;
      }
      const signature = await tx.run(() => built.ixs, built.signers ?? []);
      if (!signature) { setCurrent(null); return false; }
      setSignatures((s) => ({ ...s, [spec.id]: signature }));
      onLanded(spec.id, signature);
    }
    setCurrent(null);
    return true;
  };

  return { run, phase: tx.phase, current, signatures, reset: tx.reset };
}

export function TxList({ specs, done, signing }: { specs: TxSpec[]; done: Partial<Record<StepId, boolean>>; signing: ReturnType<typeof useSigning> }) {
  return (
    <ol className="flex flex-col border-t border-ink">
      {specs.map((s, i) => {
        const isDone = Boolean(done[s.id]);
        const isNow = signing.current === s.id;
        const sig = signing.signatures[s.id];
        return (
          <li key={s.id} className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule py-4 ${isNow ? "bg-surface" : ""}`}>
            <span aria-hidden="true" className={`pt-0.5 font-mono text-sm ${isDone ? "text-green" : isNow ? "text-blue" : "text-mute"}`}>{isDone ? "✓" : i + 1}</span>
            <span className="flex flex-col gap-0.5">
              <strong className="text-[15px] font-semibold">{s.title}</strong>
              {s.detail && <span className="text-[13px] leading-relaxed text-mute">{s.detail}</span>}
            </span>
            <span className="text-right text-[13px]">
              {sig ? (
                <a href={explorerUrl("tx", sig)} target="_blank" rel="noopener noreferrer" className="font-mono text-green underline underline-offset-2">{shortAddress(sig)} ↗</a>
              ) : isDone ? (
                <span className="text-green">Done</span>
              ) : isNow && signing.phase.kind === "busy" ? (
                <span className="text-blue">{TX_STEP[signing.phase.step]}</span>
              ) : (
                <span className="text-mute">Waiting</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function SigningError({ signing }: { signing: ReturnType<typeof useSigning> }) {
  if (signing.phase.kind !== "failed") return null;
  const e = signing.phase.error;
  return (
    <div role="alert" className="flex flex-col gap-1 border border-error bg-surface p-4">
      <strong className="text-error">{e.title}</strong>
      <span className="text-sm leading-relaxed text-ink2">{e.detail}</span>
      <span className="text-[13px] text-mute">Nothing after the last finished step was changed. Press the button again to continue from there.</span>
    </div>
  );
}
