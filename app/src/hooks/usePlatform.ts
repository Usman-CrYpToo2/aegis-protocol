import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { loadPlatform } from "../chain/platform";

/** The platform's settings and approved currencies. They change rarely, so a minute is fresh enough. */
export function usePlatform() {
  const { connection } = useConnection();
  return useQuery({ queryKey: ["platform", config.rpcUrl], queryFn: () => loadPlatform(connection), staleTime: 60_000 });
}
