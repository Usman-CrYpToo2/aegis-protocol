import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { advanceInstruction, NONCE_UNITS, sealInstruction, type Nonce } from "./nonce";
import { withBackup } from "./send";

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
/**
 * With `nonce`, the transaction starts by advancing it and carries its value instead of a blockhash,
 * so it stays valid however long a wallet takes (see chain/nonce). It is simulated without.
 */
export async function prepareTransaction(connection: Connection, payer: PublicKey, instructions: TransactionInstruction[], nonce?: Nonce, cosigned = false): Promise<PreparedTx> {
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
  const units = Math.min(1_400_000, Math.ceil(used * 1.2) + 10_000);
  if (nonce) {
    // If only the wallet signs, the transaction is sealed against being rewritten (see chain/nonce).
    // A transaction someone else co-signs (`cosigned`) is safe already.
    const seal = cosigned ? null : sealInstruction();
    const transaction = new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: nonce.value, instructions: [advanceInstruction(nonce, payer), ComputeBudgetProgram.setComputeUnitLimit({ units: units + NONCE_UNITS }), ...instructions, ...(seal ? [seal.instruction] : [])] }).compileToV0Message()
    );
    if (seal) transaction.sign([seal.signer]);
    return { transaction, blockhash: nonce.value, lastValidBlockHeight };
  }
  return { transaction: build(units), blockhash, lastValidBlockHeight };
}
