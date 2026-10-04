import type { ConnectionConfig } from "@solana/web3.js";

/**
 * Connection settings with a time limit on every request. Without one, an endpoint that accepts a
 * request and never answers leaves the page waiting forever, before a wallet is even asked. With
 * one, the request fails as a network error and the backup endpoint takes over (chain/send).
 */
export function rpcConfig(timeoutMs = 15_000): ConnectionConfig {
  return {
    commitment: "confirmed",
    fetch: (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`RPC request timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
    },
  };
}

/** Listing a program's accounts can legitimately take a while on a large registry. */
export const LISTING_TIMEOUT_MS = 45_000;
