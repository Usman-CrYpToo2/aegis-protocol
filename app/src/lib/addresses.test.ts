import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { parseWalletLines } from "./addresses";

describe("parseWalletLines", () => {
  it("sorts each pasted line into what will happen to it", () => {
    const [a, b, c, d] = Array.from({ length: 4 }, () => Keypair.generate().publicKey.toBase58());
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey(a!))[0].toBase58();
    const input = [a, "", `${b},Alice,US`, a, c, d, "not-an-address", pda, "0xcf9e1825Fe713bD6c7508b9f12c42Cb333fe839e"].join("\n");
    const out = parseWalletLines(input, new Set([c!]), new Set([d!]));
    expect(out.map((l) => [l.line, l.kind])).toEqual([
      [1, "ready"], [3, "ready"], [4, "duplicate"], [5, "known"], [6, "approved"], [7, "invalid"], [8, "program"], [9, "invalid"],
    ]);
  });
});
