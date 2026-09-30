import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { loadActivity } from "../chain/activity";
import { loadHoldings, type Holding } from "../chain/holdings";
import { useRegistry } from "./useRegistry";

/** What the connected wallet holds, built on the registry the app already reads. */
export function useHoldings() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const registry = useRegistry();
  return useQuery({
    queryKey: ["holdings", config.rpcUrl, publicKey?.toBase58(), registry.data?.readAt],
    enabled: Boolean(publicKey && registry.data),
    queryFn: () => loadHoldings(connection, registry.data!, publicKey!),
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === publicKey?.toBase58() ? previous : undefined),
  });
}

export function useActivity(holdings: Holding[] | undefined) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["activity", config.rpcUrl, publicKey?.toBase58(), holdings?.map((h) => `${h.entry.launch.address.toBase58()}:${h.security}:${h.wrapper}`).join(",")],
    enabled: Boolean(publicKey && holdings),
    queryFn: () => loadActivity(connection, publicKey!, holdings!),
    staleTime: 30_000,
  });
}
