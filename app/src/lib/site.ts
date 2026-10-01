import { config } from "../config";

/** Where the code lives, for links to the source and the design. */
export const REPO_URL = "https://github.com/Usman-CrYpToo2/aegis-protocol";

/** The network in plain words, for disclaimers. */
export const NETWORK_NAME = config.cluster === "devnet" ? "devnet" : "a local test network";
