import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import type { LaunchAccount } from "../chain/aegis";
import { loadBridgeStatus } from "../chain/bridge";

/** What the connected wallet can do at this asset's bridge. Re-read often: approval can land any time. */
export function useBridgeStatus(launch: LaunchAccount | undefined) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["bridge", config.rpcUrl, launch?.address.toBase58(), publicKey?.toBase58()],
    enabled: Boolean(launch && publicKey),
    refetchInterval: 8_000,
    queryFn: () => loadBridgeStatus(connection, launch!, publicKey!),
  });
}
