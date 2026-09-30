import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as ids from "./ids";

/** No program address in the app is trusted from memory: each is checked against its source. */
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("program ids", () => {
  it("match the IDLs and constants the program is built against", () => {
    expect(ids.AEGIS_PROGRAM_ID.toBase58()).toBe(json("../../../target/idl/aegis.json").address);
    expect(ids.TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58()).toBe(json("../../../idls/transfer_restrictions.json").address);
    expect(ids.ACCESS_CONTROL_PROGRAM_ID.toBase58()).toBe(json("../../../idls/access_control.json").address);
    const constants = readFileSync(new URL("../../../programs/aegis/src/constants.rs", import.meta.url), "utf8");
    expect(constants).toContain(`pubkey!("${ids.METEORA_DBC_PROGRAM_ID.toBase58()}")`);
    const hook = readFileSync(new URL("../../../programs/aegis-hook/src/lib.rs", import.meta.url), "utf8");
    expect(hook).toContain(`declare_id!("${ids.AEGIS_HOOK_PROGRAM_ID.toBase58()}")`);
    // Token programs come from @solana/spl-token; pin them to the addresses in the Aegis IDL.
    const tokenProgram = json("../../../target/idl/aegis.json").instructions
      .flatMap((i: { accounts: { name: string; address?: string }[] }) => i.accounts)
      .find((a: { name: string; address?: string }) => a.name === "token_program" && a.address)?.address;
    expect(ids.TOKEN_2022_PROGRAM_ID.toBase58()).toBe(tokenProgram);
  });
});
