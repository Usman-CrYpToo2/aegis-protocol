import { approveAndSend } from "../chain/approve";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Keypair, TransactionInstruction } from "@solana/web3.js";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { prepareTransaction } from "../chain/tx";
import { explainTradeError, type ErrorTable, type Explained } from "../lib/txErrors";

export type TxPhase =
  | { kind: "idle" }
  | { kind: "busy"; step: "checking" | "signing" | "again" | "confirming" }
  | { kind: "done"; signature: string }
  | { kind: "failed"; error: Explained };

export const TX_STEP = { checking: "Checking…", signing: "Approve in your wallet…", again: "Approve once more: the last one came back too late…", confirming: "Confirming…" } as const;

/**
 * Simulate, sign, confirm, explain: the same path every transaction in the app takes. `build` is
 * called at the moment of sending, so it works from the freshest state. One run at a time.
 */
export function useTxRunner(errors: ErrorTable = {}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const inFlight = useRef(false);

  const run = useCallback(
    async (build: () => Promise<TransactionInstruction[]> | TransactionInstruction[], signers: Keypair[] = []): Promise<string | null> => {
      if (!publicKey || inFlight.current) return null;
      inFlight.current = true;
      try {
        setPhase({ kind: "busy", step: "checking" });
        let retry = false;
        // New accounts created from a fresh keypair (a mint, a config) sign alongside the wallet.
        // A slow approval is rebuilt and asked for again rather than sent stale; see chain/approve.
        const signature = await approveAndSend(
          connection,
          { signTransaction, sendTransaction },
          publicKey,
          async (nonce) => {
            const prepared = await prepareTransaction(connection, publicKey, await build(), nonce, signers.length > 0);
            setPhase({ kind: "busy", step: retry ? "again" : "signing" });
            return prepared;
          },
          { signers, onSigned: () => setPhase({ kind: "busy", step: "confirming" }), onRetry: () => { retry = true; } }
        );
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
    [connection, publicKey, queryClient, sendTransaction, signTransaction]
  );

  return { phase, run, reset: () => setPhase({ kind: "idle" }) };
}
