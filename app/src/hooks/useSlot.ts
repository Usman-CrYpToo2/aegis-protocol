import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";

/**
 * The latest slot the node has confirmed, read every few seconds while the tab is visible. It is
 * the cheapest call there is, and it shows the app is reading a chain that is moving right now.
 */
export function useSlot() {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["slot", config.rpcUrl],
    queryFn: () => connection.getSlot("confirmed"),
    refetchInterval: 6_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
}
