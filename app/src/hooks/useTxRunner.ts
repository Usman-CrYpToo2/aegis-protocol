import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { TransactionInstruction } from "@solana/web3.js";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { prepareTransaction } from "../chain/tx";
import { explainTradeError, type Explained } from "../lib/txErrors";

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
export function useTxRunner() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const inFlight = useRef(false);

  const run = useCallback(
    async (build: () => Promise<TransactionInstruction[]> | TransactionInstruction[]): Promise<boolean> => {
      if (!publicKey || inFlight.current) return false;
      inFlight.current = true;
      try {
        setPhase({ kind: "busy", step: "checking" });
        const prepared = await prepareTransaction(connection, publicKey, await build());
        setPhase({ kind: "busy", step: "signing" });
        const signature = await sendTransaction(prepared.transaction, connection, { preflightCommitment: "confirmed" });
        setPhase({ kind: "busy", step: "confirming" });
        const result = await connection.confirmTransaction({ signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }, "confirmed");
        if (result.value.err) {
          const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
          throw Object.assign(new Error(JSON.stringify(result.value.err)), { logs: tx?.meta?.logMessages ?? [] });
        }
        setPhase({ kind: "done", signature });
        return true;
      } catch (e) {
        setPhase({ kind: "failed", error: explainTradeError(e) });
        return false;
      } finally {
        inFlight.current = false;
        for (const key of ["asset", "registry", "console", "health", "holdings", "balances", "register"]) void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    [connection, publicKey, queryClient, sendTransaction]
  );

  return { phase, run, reset: () => setPhase({ kind: "idle" }) };
}
