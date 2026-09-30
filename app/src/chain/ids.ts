import { PublicKey } from "@solana/web3.js";
import idl from "../idl/aegis.json";

/** Taken from the IDL, so it always matches the program the app was built against. */
export const AEGIS_PROGRAM_ID = new PublicKey(idl.address);

/** Meteora Dynamic Bonding Curve, pinned to the same program the Aegis program CPIs into. */
export const METEORA_DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

// Re-exported from the official package rather than typed by hand.
export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
