// Copies the Aegis IDL from the Anchor build into the app, so the frontend decodes accounts with
// exactly the layout the deployed program uses. Run after `anchor build`.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("src/idl", { recursive: true });
copyFileSync("../target/idl/aegis.json", "src/idl/aegis.json");
console.log("copied target/idl/aegis.json -> src/idl/aegis.json");
