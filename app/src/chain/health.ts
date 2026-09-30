/**
 * What a launch's holders are experiencing, read from the same accounts the bridge checks
 * (programs/aegis/src/compliance.rs): if any of these fails, redemption fails for everyone.
 */
import type { Connection } from "@solana/web3.js";
import type { RegistryEntry } from "./registry";
import { bridgeAddresses } from "./bridge";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "./ids";

export type Check = { id: string; ok: boolean; title: string; detail: string };

const DISC = { trd: [166, 184, 205, 98, 165, 224, 174, 148], saa: [68, 169, 137, 56, 226, 21, 69, 124], rule: [200, 231, 114, 91, 84, 241, 109, 172] };
const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

export async function loadHealth(connection: Connection, entry: RegistryEntry, waiting: number, symbols: { sym: string; wsym: string }): Promise<Check[]> {
  const { launch, backing } = entry;
  const a = bridgeAddresses(launch, launch.issuer);
  const [trd, vaultSaa, redeemRule, vault, issuerSaa] = await connection.getMultipleAccountsInfo([a.trd, a.vaultSaa, a.redeemRule, launch.escrowVault, a.userSaa], "confirmed");
  const upside = (info: typeof trd, disc: number[], min: number) =>
    info && info.owner.equals(TRANSFER_RESTRICTIONS_PROGRAM_ID) && info.data.length >= min && disc.every((b, i) => info.data[i] === b) ? info.data : null;
  const t = upside(trd, DISC.trd, 97);
  const vs = upside(vaultSaa, DISC.saa, 16);
  const rule = upside(redeemRule, DISC.rule, 64);
  const vaultFrozen = !vault || !vault.owner.equals(TOKEN_2022_PROGRAM_ID) || vault.data[108] === 2;
  const is = upside(issuerSaa, DISC.saa, 16);
  const { sym, wsym } = symbols;

  const checks: Check[] = [
    backing.kind === "backed"
      ? { id: "backing", ok: true, title: "Backing holds.", detail: "The escrow covers every wrapper in existence." }
      : backing.kind === "short"
        ? { id: "backing", ok: false, title: "Backing is short.", detail: "The escrow holds less than the wrappers in existence. The bridge has stopped for everyone." }
        : { id: "backing", ok: false, title: "Backing couldn’t be verified.", detail: "A read failed; this retries automatically." },
    t && t[96] !== 1
      ? { id: "paused", ok: true, title: "Transfers are running.", detail: `You have not paused ${sym}.` }
      : { id: "paused", ok: false, title: "Transfers are paused.", detail: `Nobody can redeem or deposit until you resume ${sym} transfers.` },
    vs && u64(vs, 8) === launch.vaultGroup && !vaultFrozen
      ? { id: "vault", ok: true, title: "The escrow is in its group.", detail: "Still in the group it was locked into when you funded it." }
      : { id: "vault", ok: false, title: "The escrow is out of place.", detail: "Its group changed or it was frozen, so the bridge refuses to move tokens." },
    rule
      ? { id: "rule", ok: true, title: "Escrow can pay investors.", detail: "A transfer rule allows escrow → Investors." }
      : { id: "rule", ok: false, title: "Escrow can’t pay investors.", detail: "The transfer rule from the escrow group to investors is missing." },
    waiting === 0
      ? { id: "waiting", ok: true, title: "Every holder can redeem.", detail: `No ${wsym} holder is waiting for approval.` }
      : { id: "waiting", ok: false, title: `${waiting} ${waiting === 1 ? "holder can’t" : "holders can’t"} redeem.`, detail: `They hold ${wsym} but are not approved.` },
  ];
  if (launch.issuerUnsold > 0n) {
    checks.push(
      is && u64(is, 8) === launch.investorGroup
        ? { id: "issuer", ok: true, title: "You can receive your unsold stock.", detail: "Your wallet is in the investor group." }
        : { id: "issuer", ok: false, title: "You can’t receive your unsold stock.", detail: "Your wallet is not in the investor group." }
    );
  }
  return checks;
}
