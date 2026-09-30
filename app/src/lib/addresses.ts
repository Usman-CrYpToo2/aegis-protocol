import { PublicKey } from "@solana/web3.js";

export type ParsedLine =
  | { line: number; text: string; kind: "ready"; wallet: PublicKey }
  | { line: number; text: string; kind: "duplicate" | "known" | "approved" | "invalid" | "program" };

/**
 * Reads pasted wallet addresses, one per line (commas and a CSV's first column also work).
 * `known` are wallets already listed as waiting; `approved` are already on the register.
 */
export function parseWalletLines(input: string, known: Set<string>, approved: Set<string>): ParsedLine[] {
  const seen = new Set<string>();
  const out: ParsedLine[] = [];
  input.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.split(/[,;\t]/)[0]!.trim().replace(/^["']|["']$/g, "");
    if (!text) return;
    const line = i + 1;
    let wallet: PublicKey;
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) throw new Error();
      wallet = new PublicKey(text);
    } catch {
      out.push({ line, text, kind: "invalid" });
      return;
    }
    const key = wallet.toBase58();
    if (!PublicKey.isOnCurve(wallet.toBytes())) out.push({ line, text, kind: "program" });
    else if (seen.has(key)) out.push({ line, text, kind: "duplicate" });
    else if (approved.has(key)) out.push({ line, text, kind: "approved" });
    else if (known.has(key)) out.push({ line, text, kind: "known" });
    else out.push({ line, text, kind: "ready", wallet });
    seen.add(key);
  });
  return out;
}

export const LINE_NOTE: Record<ParsedLine["kind"], string> = {
  ready: "ready",
  duplicate: "listed twice; approved once",
  known: "already in the list above",
  approved: "already on the register",
  invalid: "this is not a Solana address",
  program: "a program address, not a wallet; it can’t sign for itself",
};
