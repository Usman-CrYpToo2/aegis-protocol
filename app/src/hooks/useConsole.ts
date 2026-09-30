import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { attentionItems, loadConsole } from "../chain/console";
import { useIsIssuer, useRegistry } from "./useRegistry";

/** The connected wallet's launches, if it has issued any. */
export function useConsole() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const registry = useRegistry();
  const isIssuer = useIsIssuer();
  const query = useQuery({
    queryKey: ["console", config.rpcUrl, publicKey?.toBase58(), registry.data?.readAt],
    enabled: Boolean(publicKey && registry.data && isIssuer),
    queryFn: () => loadConsole(connection, registry.data!, publicKey!),
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === publicKey?.toBase58() ? previous : undefined),
  });
  return { ...query, attention: query.data ? attentionItems(query.data) : [], isIssuer };
}
