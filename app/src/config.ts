import { PublicKey } from "@solana/web3.js";

export type Cluster = "localnet" | "devnet";

function readCluster(value: string | undefined): Cluster {
  if (value === undefined || value === "") return "localnet";
  if (value === "localnet" || value === "devnet") return value;
  throw new Error(`VITE_CLUSTER must be "localnet" or "devnet", got "${value}".`);
}

function readRpcUrl(value: string | undefined, cluster: Cluster): string {
  const url = value || (cluster === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");
  const parsed = new URL(url); // throws on garbage, which is what we want at startup
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`VITE_RPC_URL must be http(s), got "${url}".`);
  }
  if (cluster === "devnet" && parsed.protocol !== "https:") {
    throw new Error("VITE_RPC_URL must use https on devnet.");
  }
  return url;
}

/** Quote mints whose symbol is known without configuration. */
const KNOWN_QUOTES: Record<Cluster, Record<string, string>> = {
  // Circle's devnet USDC.
  devnet: { "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC" },
  localnet: {},
};

/** `mint=SYMBOL,mint=SYMBOL`, on top of the known ones. Invalid entries are dropped, not fatal. */
function readQuoteLabels(value: string | undefined, cluster: Cluster): Map<string, string> {
  const labels = new Map<string, string>(Object.entries(KNOWN_QUOTES[cluster]));
  for (const entry of (value ?? "").split(",")) {
    const [mint, symbol] = entry.split("=").map((s) => s.trim());
    if (!mint || !symbol || !/^[A-Za-z0-9.$]{1,10}$/.test(symbol)) continue;
    try {
      labels.set(new PublicKey(mint).toBase58(), symbol);
    } catch {
      // not a public key; ignore
    }
  }
  return labels;
}

const cluster = readCluster(import.meta.env.VITE_CLUSTER);

export const config = {
  cluster,
  rpcUrl: readRpcUrl(import.meta.env.VITE_RPC_URL, cluster),
  quoteLabels: readQuoteLabels(import.meta.env.VITE_QUOTE_LABELS, cluster),
  /** How often on-chain state is re-read while the page is open. */
  refreshMs: 15_000,
} as const;

/** Explorer link that works for both clusters, including a local validator. */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (config.cluster === "devnet") return `${base}?cluster=devnet`;
  return `${base}?cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`;
}

/** Where a graduated pool can be traded. A local node has no Meteora site, so it falls back to the explorer. */
export function meteoraPoolUrl(pool: string): string {
  return config.cluster === "devnet" ? `https://devnet.meteora.ag/dammv2/${pool}` : explorerUrl("address", pool);
}
