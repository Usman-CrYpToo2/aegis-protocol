import type { LaunchStage } from "./aegis";

/**
 * What the registry can honestly say about one launch's backing. There is deliberately no state
 * that means "probably fine": if a read failed, the answer is `unknown`, never `backed`.
 */
export type Backing =
  | { kind: "not-funded" }
  | { kind: "escrowed"; escrowed: bigint }
  | { kind: "backed"; escrowed: bigint; circulating: bigint }
  | { kind: "short"; escrowed: bigint; required: bigint }
  | { kind: "withdrawn" }
  | { kind: "unknown"; reason: string };

export type BackingInputs = {
  stage: LaunchStage;
  totalSupply: bigint;
  /** Escrow vault balance, or undefined if the vault is not set or could not be read. */
  escrowed?: bigint;
  /** Wrapper mint supply, or undefined before the wrapper exists or if it could not be read. */
  circulating?: bigint;
};

export function assessBacking({ stage, totalSupply, escrowed, circulating }: BackingInputs): Backing {
  switch (stage) {
    case "Aborted":
      return { kind: "withdrawn" };
    case "TokenCreated":
      return { kind: "not-funded" };
    case "Funded":
    case "Configured":
      // Before a wrapper exists the promise is simpler: the whole issue sits in escrow.
      if (escrowed === undefined) return { kind: "unknown", reason: "escrow could not be read" };
      return escrowed >= totalSupply
        ? { kind: "escrowed", escrowed }
        : { kind: "short", escrowed, required: totalSupply };
    case "Live":
    case "Graduated":
      if (escrowed === undefined) return { kind: "unknown", reason: "escrow could not be read" };
      if (circulating === undefined) return { kind: "unknown", reason: "wrapper supply could not be read" };
      // The on-chain invariant: every wrapper in existence is backed by at least one unit in
      // escrow. After graduation the vault also holds the issuer's unclaimed unsold stock, so
      // "more than enough" is normal and still means backed.
      return escrowed >= circulating
        ? { kind: "backed", escrowed, circulating }
        : { kind: "short", escrowed, required: circulating };
  }
}
