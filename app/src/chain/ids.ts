import { PublicKey } from "@solana/web3.js";
import idl from "../idl/aegis.json";

/** Taken from the IDL, so it always matches the program the app was built against. */
export const AEGIS_PROGRAM_ID = new PublicKey(idl.address);

/** Meteora Dynamic Bonding Curve, pinned to the same program the Aegis program CPIs into. */
/** The transfer hook Meteora attaches to every wrapper, as the Aegis program names it. */
export const AEGIS_HOOK_PROGRAM_ID = new PublicKey(
  (idl.instructions.find((i) => i.name === "launch_pool")!.accounts as { name: string; address?: string }[]).find((a) => a.name === "aegis_hook_program")!.address!
);

export const METEORA_DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

// Re-exported from the official package rather than typed by hand.
export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

/** Upside's compliance programs, which own the Real RWA's registry and transfer hook.
 *  ids.test.ts checks every id in this file against the IDLs the program is built from. */
export const TRANSFER_RESTRICTIONS_PROGRAM_ID = new PublicKey("6yEnqdEjX3zBBDkzhwTRGJwv1jRaN4QE4gywmgdcfPBZ");
export const ACCESS_CONTROL_PROGRAM_ID = new PublicKey("4X79YRjz9KNMhdjdxXg2ZNTS3YnMGYdwJkBHnezMJwr3");
