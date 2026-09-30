// Copies the IDLs the app builds instructions from, so it always matches the programs it talks to.
// Run after `anchor build`.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("src/idl", { recursive: true });
for (const [from, to] of [
  ["../target/idl/aegis.json", "src/idl/aegis.json"],
  ["../idls/transfer_restrictions.json", "src/idl/transfer_restrictions.json"],
]) {
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
