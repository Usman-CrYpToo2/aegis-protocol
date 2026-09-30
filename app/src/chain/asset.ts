import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeLaunch } from "./aegis";
import { AEGIS_PROGRAM_ID } from "./ids";
import { buildEntry, ProgramNotDeployedError, readMany, relatedAccounts, type RegistryEntry } from "./registry";

export class AssetNotFoundError extends Error {
  constructor(public readonly reason: "invalid-address" | "not-registered") {
    super(reason === "invalid-address" ? "That is not a valid address." : "No asset is registered under this address.");
  }
}

/** Parses the mint from a URL. Anything that is not a public key is a not-found, never a crash. */
export function parseMint(value: string | undefined): PublicKey {
  try {
    if (!value || value.length > 44) throw new Error();
    return new PublicKey(value);
  } catch {
    throw new AssetNotFoundError("invalid-address");
  }
}

/** The launch is the PDA ["launch", real_rwa_mint], so one asset can only ever have one launch. */
export const launchAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("launch"), mint.toBuffer()], AEGIS_PROGRAM_ID)[0];

export async function loadAsset(connection: Connection, mint: PublicKey): Promise<RegistryEntry & { readAt: number }> {
  const address = launchAddress(mint);
  const [program, info] = await connection.getMultipleAccountsInfo([AEGIS_PROGRAM_ID, address], "confirmed");
  if (!program?.executable) throw new ProgramNotDeployedError();
  if (!info || !info.owner.equals(AEGIS_PROGRAM_ID)) throw new AssetNotFoundError("not-registered");

  const launch = decodeLaunch(address, info.data);
  const accounts = await readMany(connection, relatedAccounts(launch));
  return { ...buildEntry(launch, accounts), readAt: Date.now() };
}
