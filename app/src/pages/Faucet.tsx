import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { dripInstructions, faucetKind, MAX_WHOLE_PER_CLAIM, requestSol } from "../chain/faucet";
import { useConnectModal } from "../components/connect/ConnectModal";
import { usePlatform } from "../hooks/usePlatform";
import { TX_STEP, useTxRunner } from "../hooks/useTxRunner";
import { formatUnits } from "../lib/amount";

/** A token the faucet can send: SOL from the network's own faucet, the rest minted by the Aegis faucet. */
type FaucetToken = { symbol: string; mint: PublicKey; decimals: number; program: PublicKey; sol: boolean; amounts: bigint[] };

const SOL: FaucetToken = { symbol: "SOL", mint: NATIVE_MINT, decimals: 9, program: TOKEN_PROGRAM_ID, sol: true, amounts: [500_000_000n, 1_000_000_000n] };
const PUBLIC_DEVNET = "https://api.devnet.solana.com";
const MINT_AMOUNTS = [100n, 1_000n, MAX_WHOLE_PER_CLAIM];
/** Enough SOL for the fee and a new token account's deposit. */
const FEE_FLOOR = 5_000_000n;
const DEFAULT_AMOUNT = { sol: 1, mint: 1 }; // index into amounts: 1 SOL, 1,000 tokens

const inputCls = "min-h-12 w-full border border-line bg-white px-3 text-[16px] outline-none focus:border-ink aria-[invalid=true]:border-error";

/** Every approved currency the Aegis faucet can mint, then SOL. The first is selected by default. */
function useFaucetTokens() {
  const { connection } = useConnection();
  const platform = usePlatform();
  const quotes = platform.data?.quotes;
  return useQuery({
    queryKey: ["faucetTokens", config.rpcUrl, quotes?.map((q) => q.mint.toBase58()).join()],
    enabled: Boolean(quotes),
    staleTime: 60_000,
    queryFn: async (): Promise<FaucetToken[]> => {
      const others = quotes!.filter((q) => !q.mint.equals(NATIVE_MINT));
      const mints = await connection.getMultipleAccountsInfo(others.map((q) => q.mint), "confirmed");
      const mintable = others.filter((q, i) => {
        const m = mints[i];
        return m && faucetKind(q.mint, unpackMint(q.mint, m as AccountInfo<Buffer>, q.program).mintAuthority) === "mint";
      });
      return [...mintable.map((q) => ({ symbol: q.symbol, mint: q.mint, decimals: q.decimals, program: q.program, sol: false, amounts: MINT_AMOUNTS.map((n) => n * 10n ** BigInt(q.decimals)) })), SOL];
    },
  });
}

function useBalance(token: FaucetToken | undefined, owner: PublicKey | null) {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["faucet", config.rpcUrl, token?.mint.toBase58(), owner?.toBase58()],
    enabled: Boolean(token && owner),
    refetchInterval: 10_000,
    queryFn: async () => {
      if (token!.sol) return BigInt(await connection.getBalance(owner!, "confirmed"));
      const info = await connection.getAccountInfo(getAssociatedTokenAddressSync(token!.mint, owner!, true, token!.program), "confirmed");
      return info && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
    },
  });
}

const parseAddress = (text: string): PublicKey | null => {
  try {
    return text.trim() ? new PublicKey(text.trim()) : null;
  } catch {
    return null;
  }
};

type Airdrop = { kind: "idle" } | { kind: "busy" } | { kind: "done"; signature: string } | { kind: "failed" };

export function FaucetPage() {
  const id = useId();
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tokens = useFaucetTokens();
  const tx = useTxRunner();
  const [airdrop, setAirdrop] = useState<Airdrop>({ kind: "idle" });

  const list = tokens.data ?? [SOL];
  const token = list.find((t) => t.symbol === params.get("token")) ?? list[0]!;
  const [amountIndex, setAmountIndex] = useState<number>(DEFAULT_AMOUNT.sol);
  const amount = token.amounts[Math.min(amountIndex, token.amounts.length - 1)]!;

  // The address follows the connected wallet until someone types a different one.
  const [text, setText] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) setText(publicKey?.toBase58() ?? ""); }, [publicKey, edited]);
  const to = parseAddress(text);
  const balance = useBalance(token, to);
  // Minting is paid for in SOL by the connected wallet, so a brand-new wallet needs SOL first.
  const payerSol = useBalance(SOL, token.sol ? null : publicKey);
  const needsSol = !token.sol && payerSol.data !== undefined && payerSol.data < FEE_FLOOR;

  useEffect(() => {
    document.title = "Faucet — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, []);

  const label = `${formatUnits(amount, token.decimals)} ${token.symbol}`;
  const busy = airdrop.kind === "busy" || tx.phase.kind === "busy";
  const reset = () => { setAirdrop({ kind: "idle" }); tx.reset(); };

  const choose = (symbol: string) => {
    const next = list.find((t) => t.symbol === symbol)!;
    setParams({ token: symbol }, { replace: true });
    setAmountIndex(next.sol ? DEFAULT_AMOUNT.sol : DEFAULT_AMOUNT.mint);
    reset();
  };

  async function send() {
    if (!to || busy) return;
    reset();
    if (token.sol) {
      setAirdrop({ kind: "busy" });
      try {
        // Our endpoint first, then Solana's public one, which limits each visitor separately.
        const signature = await requestSol([connection, new Connection(PUBLIC_DEVNET, "confirmed")], connection, to, Number(amount));
        setAirdrop({ kind: "done", signature });
      } catch {
        setAirdrop({ kind: "failed" });
      }
    } else {
      await tx.run(() => dripInstructions(token.mint, to, amount, token.program, publicKey!));
    }
    void queryClient.invalidateQueries({ queryKey: ["faucet"] });
    void queryClient.invalidateQueries({ queryKey: ["balances"] });
  }

  // Minting is a transaction: a wallet has to approve it and pay its tiny fee. SOL needs nothing.
  const needsWallet = !token.sol && !publicKey;
  const done = airdrop.kind === "done" ? airdrop.signature : tx.phase.kind === "done" ? tx.phase.signature : null;
  const failed = airdrop.kind === "failed"
    ? "Solana’s faucets didn’t send it. They limit how often anyone can ask; try again in a while, or use faucet.solana.com."
    : tx.phase.kind === "failed" ? `${tx.phase.error.title}. ${tx.phase.error.detail}` : null;

  return (
    <div className="flex justify-center px-4 py-12 sm:py-20">
      <div className="flex w-full max-w-[480px] flex-col gap-4">
        <section aria-labelledby={`${id}-title`} className="flex flex-col gap-5 border border-ink bg-surface p-6 sm:p-7">
          <div className="flex flex-col gap-1">
            <h1 id={`${id}-title`} className="font-serif text-4xl">Get test tokens</h1>
            <p className="text-[15px] text-ink2">Free on Solana devnet. They have no real value.</p>
          </div>

          {config.cluster !== "devnet" ? (
            <p role="status" className="text-[15px] text-ink2">The faucet works on devnet. A local network funds wallets with its own scripts.</p>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_9rem] gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold">Token</span>
                  <select className={inputCls} value={token.symbol} onChange={(e) => choose(e.target.value)} disabled={busy}>
                    {list.map((t) => <option key={t.symbol} value={t.symbol}>{t.symbol}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold">Amount</span>
                  <select className={`${inputCls} font-mono`} value={Math.min(amountIndex, token.amounts.length - 1)} onChange={(e) => { setAmountIndex(Number(e.target.value)); reset(); }} disabled={busy}>
                    {token.amounts.map((a, i) => <option key={a.toString()} value={i}>{formatUnits(a, token.decimals)}</option>)}
                  </select>
                </label>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-to`} className="text-sm font-semibold">Wallet address</label>
                <input
                  id={`${id}-to`}
                  className={`${inputCls} font-mono text-[14px]`}
                  placeholder="Paste a Solana address"
                  spellCheck={false}
                  autoComplete="off"
                  value={text}
                  disabled={busy}
                  onChange={(e) => { setText(e.target.value); setEdited(true); reset(); }}
                  aria-invalid={text.trim() !== "" && !to}
                  aria-describedby={`${id}-to-hint`}
                />
                <span id={`${id}-to-hint`} className={`text-[13px] ${text.trim() && !to ? "text-error" : "text-mute"}`}>
                  {text.trim() && !to
                    ? "That isn’t a Solana address."
                    : to && balance.data !== undefined
                      ? <>Balance <span className="font-mono num">{formatUnits(balance.data, token.decimals, { maxFraction: 4 })} {token.symbol}</span></>
                      : " "}
                </span>
              </div>

              {needsWallet ? (
                <button type="button" onClick={openConnect} className="min-h-12 cursor-pointer bg-ink font-semibold text-paper hover:bg-ink2">
                  Connect a wallet to send {token.symbol}
                </button>
              ) : needsSol ? (
                <div className="flex flex-col gap-2">
                  <button type="button" onClick={() => choose("SOL")} className="min-h-12 cursor-pointer bg-blue font-semibold text-white hover:bg-blue-deep">
                    Get SOL first
                  </button>
                  <p className="text-[13px] leading-relaxed text-ink2">Your wallet has no SOL yet, and sending {token.symbol} needs a tiny fee in SOL. Get SOL, then come back for {token.symbol}.</p>
                </div>
              ) : (
                <button type="button" onClick={() => void send()} disabled={!to || busy} className="min-h-12 cursor-pointer bg-blue font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40">
                  {airdrop.kind === "busy" ? "Sending…" : tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : `Send ${label}`}
                </button>
              )}

              {done && (
                <p role="status" className="text-[14px] text-green">
                  Sent {label}.{" "}
                  <a href={explorerUrl("tx", done)} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                    View the transaction<span className="sr-only"> (opens Solana Explorer)</span> ↗
                  </a>
                </p>
              )}
              {failed && <p role="alert" className="text-[14px] leading-relaxed text-error">{failed}</p>}
            </>
          )}
        </section>

        <p className="px-1 text-[13px] leading-relaxed text-mute">
          SOL comes from the network’s faucet, which limits requests per wallet; for more, use{" "}
          <a href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">faucet.solana.com<span className="sr-only"> (opens in a new tab)</span></a>.
          Other tokens are minted by the Aegis faucet, up to {formatUnits(MAX_WHOLE_PER_CLAIM, 0)} per request; sending them needs a connected wallet to approve.
        </p>
      </div>
    </div>
  );
}
