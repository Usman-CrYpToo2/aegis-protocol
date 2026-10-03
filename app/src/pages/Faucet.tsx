import { getAssociatedTokenAddressSync, unpackMint } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, type AccountInfo } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { dripInstructions, faucetKind, MAX_WHOLE_PER_CLAIM, type FaucetKind } from "../chain/faucet";
import type { QuoteToken } from "../chain/platform";
import { confirmSignature } from "../chain/send";
import { useConnectModal } from "../components/connect/ConnectModal";
import { usePlatform } from "../hooks/usePlatform";
import { TX_STEP, useTxRunner } from "../hooks/useTxRunner";
import { formatUnits } from "../lib/amount";

const SOL_FAUCET = "https://faucet.solana.com";
/** What one request to the network's own faucet reliably delivers. */
const AIRDROP_LAMPORTS = LAMPORTS_PER_SOL;
const CLAIMS = [100n, 1_000n, MAX_WHOLE_PER_CLAIM] as const;

type Token = QuoteToken & { kind: FaucetKind; balance: bigint };
type FaucetState = { sol: bigint; tokens: Token[] };

/** The wallet's SOL, and for each approved currency: what the faucet can do for it, and the balance. */
function useFaucetState(quotes: QuoteToken[] | undefined) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery({
    queryKey: ["faucet", config.rpcUrl, publicKey?.toBase58(), quotes?.map((q) => q.mint.toBase58()).join()],
    enabled: Boolean(quotes),
    refetchInterval: 10_000,
    queryFn: async (): Promise<FaucetState> => {
      const list = quotes!;
      const atas = publicKey ? list.map((q) => getAssociatedTokenAddressSync(q.mint, publicKey, false, q.program)) : [];
      const infos = await connection.getMultipleAccountsInfo([...list.map((q) => q.mint), ...(publicKey ? [publicKey, ...atas] : [])], "confirmed");
      const mints = infos.slice(0, list.length);
      const wallet = publicKey ? infos[list.length] : null;
      const accounts = publicKey ? infos.slice(list.length + 1) : [];
      const tokens = list.map((q, i) => {
        const m = mints[i];
        const authority = m ? unpackMint(q.mint, m as AccountInfo<Buffer>, q.program).mintAuthority : null;
        const a = accounts[i];
        const balance = a && a.owner.equals(q.program) && a.data.length >= 72 ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
        return { ...q, kind: faucetKind(q.mint, authority), balance };
      });
      return { sol: BigInt(wallet?.lamports ?? 0), tokens };
    },
  });
}

function Row({ symbol, title, children, aside }: { symbol: string; title: ReactNode; children: ReactNode; aside: ReactNode }) {
  return (
    <section aria-label={symbol} className="grid gap-5 border-b border-rule py-7 md:grid-cols-[1fr_minmax(0,22rem)] md:gap-10">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-sm text-mute">{symbol}</span>
        <h2 className="font-serif text-3xl leading-tight">{title}</h2>
        <div className="max-w-xl text-[15px] leading-relaxed text-ink2">{children}</div>
      </div>
      <div className="flex flex-col gap-3">{aside}</div>
    </section>
  );
}

function Balance({ value, decimals, symbol }: { value: bigint | undefined; decimals: number; symbol: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule pb-2 text-sm">
      <span className="text-ink2">Your balance</span>
      <span className="font-mono num">{value === undefined ? "—" : `${formatUnits(value, decimals, { maxFraction: 4 })} ${symbol}`}</span>
    </div>
  );
}

function Done({ signature, children }: { signature: string; children: ReactNode }) {
  return (
    <p role="status" className="text-[13px] text-green">
      {children}{" "}
      <a href={explorerUrl("tx", signature)} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
        View<span className="sr-only"> the transaction (opens Solana Explorer)</span> ↗
      </a>
    </p>
  );
}

type Airdrop = { kind: "idle" } | { kind: "busy" } | { kind: "done"; signature: string } | { kind: "failed" };

function SolRow({ sol, solPriced }: { sol: bigint | undefined; solPriced: boolean }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Airdrop>({ kind: "idle" });

  async function request() {
    if (!publicKey || state.kind === "busy") return;
    setState({ kind: "busy" });
    try {
      const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const signature = await connection.requestAirdrop(publicKey, AIRDROP_LAMPORTS);
      await confirmSignature(connection, signature, lastValidBlockHeight);
      setState({ kind: "done", signature });
    } catch {
      setState({ kind: "failed" });
    } finally {
      void queryClient.invalidateQueries({ queryKey: ["faucet"] });
      void queryClient.invalidateQueries({ queryKey: ["balances"] });
    }
  }

  return (
    <Row
      symbol="SOL"
      title="SOL, for network fees"
      aside={
        <>
          <Balance value={sol} decimals={9} symbol="SOL" />
          <button type="button" onClick={() => void request()} disabled={!publicKey || state.kind === "busy"} className="min-h-12 cursor-pointer bg-blue font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40">
            {state.kind === "busy" ? "Requesting…" : "Get 1 SOL"}
          </button>
          {state.kind === "done" && <Done signature={state.signature}>1 SOL is in your wallet.</Done>}
          {state.kind === "failed" && (
            <p role="alert" className="text-[13px] leading-relaxed text-error">
              The network’s faucet didn’t send it; it limits how often each wallet can ask. Try again later, or use the official faucet below.
            </p>
          )}
          <a href={SOL_FAUCET} target="_blank" rel="noopener noreferrer" className="text-sm text-blue underline underline-offset-2">
            More from faucet.solana.com<span className="sr-only"> (opens in a new tab)</span> ↗
          </a>
        </>
      }
    >
      <p>Every transaction pays a small network fee in SOL, so get some first.{solPriced && " Sales priced in SOL are paid from it too: the app wraps the SOL it needs as you buy, and anything it wrapped comes back as SOL."}</p>
    </Row>
  );
}

function TokenRow({ token }: { token: Token }) {
  const { publicKey } = useWallet();
  const tx = useTxRunner();
  const queryClient = useQueryClient();
  const [whole, setWhole] = useState<bigint>(1_000n);
  const amount = (n: bigint) => formatUnits(n * 10n ** BigInt(token.decimals), token.decimals);
  const busy = tx.phase.kind === "busy";

  async function claim() {
    const atoms = whole * 10n ** BigInt(token.decimals);
    await tx.run(() => dripInstructions(token.mint, publicKey!, atoms, token.program));
    void queryClient.invalidateQueries({ queryKey: ["faucet"] });
  }

  if (token.kind === "none") {
    return (
      <Row symbol={token.symbol} title={`${token.symbol} isn’t available here`} aside={<Balance value={publicKey ? token.balance : undefined} decimals={token.decimals} symbol={token.symbol} />}>
        <p>Sales can be priced in {token.symbol}, but this faucet can’t mint it. Get it from its issuer’s own devnet faucet.</p>
      </Row>
    );
  }
  return (
    <Row
      symbol={token.symbol}
      title={`Test ${token.symbol}, for buying into sales`}
      aside={
        <>
          <Balance value={publicKey ? token.balance : undefined} decimals={token.decimals} symbol={token.symbol} />
          <div role="radiogroup" aria-label="Amount" className="grid grid-cols-3">
            {CLAIMS.map((n) => (
              <button key={n.toString()} type="button" role="radio" aria-checked={whole === n} disabled={busy} onClick={() => setWhole(n)}
                className={`-ml-px min-h-10 cursor-pointer border font-mono text-sm first:ml-0 ${whole === n ? "relative border-ink bg-ink text-paper" : "border-line hover:border-ink"}`}>
                {amount(n)}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void claim()} disabled={!publicKey || busy} className="min-h-12 cursor-pointer bg-blue font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40">
            {busy && tx.phase.kind === "busy" ? TX_STEP[tx.phase.step] : `Get ${amount(whole)} ${token.symbol}`}
          </button>
          {tx.phase.kind === "done" && <Done signature={tx.phase.signature}>It’s in your wallet.</Done>}
          {tx.phase.kind === "failed" && <p role="alert" className="text-[13px] leading-relaxed text-error">{tx.phase.error.title}. {tx.phase.error.detail}</p>}
        </>
      }
    >
      <p>
        Test money with no value, minted to you on the spot by the Aegis faucet. Up to {amount(MAX_WHOLE_PER_CLAIM)} per claim; claim again whenever you need more. Your first claim also opens a {token.symbol} account in your wallet, which costs a small deposit in SOL.
      </p>
    </Row>
  );
}

export function FaucetPage() {
  const { publicKey } = useWallet();
  const { open: openConnect } = useConnectModal();
  const platform = usePlatform();
  const state = useFaucetState(platform.data?.quotes);

  useEffect(() => {
    document.title = "Faucet — Aegis";
    return () => { document.title = "Aegis — The Registry"; };
  }, []);

  const tokens = state.data?.tokens ?? [];
  const solPriced = tokens.some((t) => t.kind === "sol");

  return (
    <div className="shell flex flex-col gap-10 py-12 lg:py-16">
      <section className="flex flex-col gap-4">
        <span className="kicker">Devnet · test money</span>
        <h1 className="font-serif text-6xl leading-[0.98] sm:text-7xl lg:text-[80px]">Faucet</h1>
        <p className="max-w-2xl text-lg leading-relaxed text-ink2">
          Aegis runs on Solana’s devnet, where nothing has real value. Get SOL for network fees, then the currency a sale is priced in, and try a whole launch for yourself in the <Link to="/registry" className="text-blue underline underline-offset-4">registry</Link>.
        </p>
      </section>

      {config.cluster !== "devnet" ? (
        <p role="status" className="border border-ink bg-surface p-5 text-ink2">The faucet works on devnet. This app is connected to a local network, where every wallet can be funded directly.</p>
      ) : (
        <div className="flex flex-col border-t border-ink">
          {!publicKey && (
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule py-5">
              <span className="text-[15px] text-ink2">Connect a wallet to fill it with test money.</span>
              <button type="button" onClick={openConnect} className="min-h-12 cursor-pointer bg-ink px-5 font-semibold text-paper hover:bg-ink2">Connect a wallet</button>
            </div>
          )}
          <SolRow sol={publicKey ? state.data?.sol : undefined} solPriced={solPriced} />
          {platform.isLoading || state.isLoading ? (
            <p className="py-7 text-ink2">Reading the approved currencies…</p>
          ) : platform.isError || state.isError ? (
            <p role="alert" className="py-7 text-error">The approved currencies couldn’t be read. Check the network and reload.</p>
          ) : (
            tokens.filter((t) => t.kind !== "sol").map((t) => <TokenRow key={t.mint.toBase58()} token={t} />)
          )}
        </div>
      )}
    </div>
  );
}

