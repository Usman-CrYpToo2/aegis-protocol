import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { AssetNotFoundError, loadAsset, parseMint } from "../chain/asset";

export function useAsset(mintParam: string | undefined) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["asset", config.rpcUrl, mintParam],
    queryFn: () => loadAsset(connection, parseMint(mintParam)),
    // An open offering moves with every trade, so this page re-reads more often than the list.
    refetchInterval: (query) => (query.state.error instanceof AssetNotFoundError ? false : 8_000),
    retry: (count, error) => !(error instanceof AssetNotFoundError) && count < 2,
    // Keep the last read on screen during a refresh, but only for the same asset: never show one
    // asset's numbers under another's name while navigating between them.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === mintParam ? previous : undefined),
  });
}
