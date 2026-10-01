import { confirmSignature } from "../chain/send";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Keypair, TransactionInstruction } from "@solana/web3.js";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { prepareTransaction } from "../chain/tx";
import { explainTradeError, type ErrorTable, type Explained } from "../lib/txErrors";

export type TxPhase =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "signing" | "confirming" }
  | { kind: "done"; signature: string }
  | { kind: "failed"; error: Explained };

export const TX_STEP = { checking: "Checking…", signing: "Approve in your wallet…", confirming: "Confirming…" } as const;

/**
 * Simulate, sign, confirm, explain: the same path every transaction in the app takes. `build` is
 * called at the moment of sending, so it works from the freshest state. One run at a time.
 */
export function useTxRunner(errors: ErrorTable = {}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const inFlight = useRef(false);

  const run = useCallback(
    async (build: () => Promise<TransactionInstruction[]> | TransactionInstruction[], signers: Keypair[] = []): Promise<string | null> => {
      if (!publicKey || inFlight.current) return null;
      inFlight.current = true;
      try {
        setPhase({ kind: "busy", step: "checking" });
        const prepared = await prepareTransaction(connection, publicKey, await build());
        setPhase({ kind: "busy", step: "signing" });
        // New accounts created from a fresh keypair (a mint, a config) sign alongside the wallet.
        const signature = await sendTransaction(prepared.transaction, connection, { preflightCommitment: "confirmed", signers });
        setPhase({ kind: "busy", step: "confirming" });
        await confirmSignature(connection, signature, prepared.lastValidBlockHeight);
        setPhase({ kind: "done", signature });
        return signature;
      } catch (e) {
        setPhase({ kind: "failed", error: explainTradeError(e, errors) });
        return null;
      } finally {
        inFlight.current = false;
        for (const key of ["asset", "registry", "console", "health", "holdings", "balances", "register", "issue", "sol"]) void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    [connection, publicKey, queryClient, sendTransaction]
  );

  return { phase, run, reset: () => setPhase({ kind: "idle" }) };
}
