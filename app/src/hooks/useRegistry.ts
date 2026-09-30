import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { loadRegistry } from "../chain/registry";

export function useRegistry() {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["registry", config.rpcUrl],
    queryFn: () => loadRegistry(connection),
    refetchInterval: config.refreshMs,
    // Keep showing the last good read while a refresh is in flight or has failed.
    placeholderData: (previous) => previous,
  });
}

/**
 * Whether the connected wallet issued at least one launch. Read from the registry the page
 * already loaded, so it costs no extra request. `undefined` while that is not yet known, so the
 * header never flashes issuer links in and out.
 */
export function useIsIssuer(): boolean | undefined {
  const { publicKey } = useWallet();
  const registry = useRegistry();
  if (!publicKey) return false;
  if (!registry.data) return undefined;
  return registry.data.entries.some((e) => e.launch.issuer.equals(publicKey));
}
