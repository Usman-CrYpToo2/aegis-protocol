import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { config } from "../config";
import { TOKEN_2022_PROGRAM_ID } from "../chain/ids";

export type WalletBalances = { sol: bigint; quote: bigint; wrapper: bigint };

/** The connected wallet's SOL, quote and wrapper balances for one sale. Missing accounts are 0. */
export function useWalletBalances(quoteMint: PublicKey | null, quoteProgram: PublicKey | null, wrapperMint: PublicKey | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["balances", config.rpcUrl, publicKey?.toBase58(), quoteMint?.toBase58(), wrapperMint?.toBase58()],
    enabled: Boolean(publicKey && quoteMint && quoteProgram && wrapperMint),
    refetchInterval: 10_000,
    queryFn: async (): Promise<WalletBalances> => {
      const owner = publicKey!;
      const quoteAta = getAssociatedTokenAddressSync(quoteMint!, owner, false, quoteProgram!);
      const wrapperAta = getAssociatedTokenAddressSync(wrapperMint!, owner, false, TOKEN_2022_PROGRAM_ID);
      const [solInfo, quoteInfo, wrapperInfo] = await connection.getMultipleAccountsInfo([owner, quoteAta, wrapperAta], "confirmed");
      // A token account's amount is the u64 at byte 64, the same for both token programs.
      const amount = (info: typeof quoteInfo, program: PublicKey) =>
        info && info.owner.equals(program) && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
      return { sol: BigInt(solInfo?.lamports ?? 0), quote: amount(quoteInfo, quoteProgram!), wrapper: amount(wrapperInfo, TOKEN_2022_PROGRAM_ID) };
    },
  });
}
