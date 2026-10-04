import { withBackup } from "./send";
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";

export type PreparedTx = { transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number };

export class SimulationError extends Error {
  constructor(public readonly logs: string[], message: string) {
    super(message);
  }
}

/**
 * Simulates first, so a transaction that would fail is explained before the wallet is ever
 * opened, and so the compute limit can be sized to what it really uses (plus headroom).
 */
export async function prepareTransaction(connection: Connection, payer: PublicKey, instructions: TransactionInstruction[]): Promise<PreparedTx> {
  const { blockhash, lastValidBlockHeight } = await withBackup(connection, (c) => c.getLatestBlockhash("confirmed"));
  const build = (units: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
      }).compileToV0Message()
    );

  const sim = await withBackup(connection, (c) => c.simulateTransaction(build(1_400_000), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }));
  if (sim.value.err) {
    throw new SimulationError(sim.value.logs ?? [], typeof sim.value.err === "string" ? sim.value.err : JSON.stringify(sim.value.err));
  }
  const used = sim.value.unitsConsumed ?? 400_000;
  return { transaction: build(Math.min(1_400_000, Math.ceil(used * 1.2) + 10_000)), blockhash, lastValidBlockHeight };
}
