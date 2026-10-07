import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pager, usePages } from "../Pager";
import { config, explorerUrl } from "../../config";
import type { ConsoleLaunch } from "../../chain/console";
import { loadRegister } from "../../chain/investors";
import { freezeInstruction, loadPaused, pauseInstruction } from "../../chain/powers";
import { useTxRunner } from "../../hooks/useTxRunner";
import { formatUnits, shortAddress } from "../../lib/amount";
import { ConfirmDialog } from "../ConfirmDialog";
import { Hint } from "../Hint";

type Pending = { kind: "pause" | "resume" } | { kind: "freeze" | "unfreeze"; wallet: PublicKey };

function Card({ title, hint, status, children }: { title: string; hint: ReactNode; status: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-b border-rule py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-1 text-[17px] font-semibold">{title}<Hint>{hint}</Hint></h3>
        <span className="text-sm">{status}</span>
      </div>
      {children}
    </section>
  );
}

/** Pause and freeze, each behind a typed confirmation. Moving or burning has no button by design. */
export function Powers({ launch }: { launch: ConsoleLaunch }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTxRunner();
  const l = launch.entry.launch;
  const mint = l.realRwaMint;
  const sym = launch.entry.label?.symbol ?? "the security";
  const wsym = launch.entry.wrapperLabel?.symbol ?? "the wrapper";
  const [pending, setPending] = useState<Pending | null>(null);
  const [pick, setPick] = useState("");

  const paused = useQuery({ queryKey: ["register", "paused", config.rpcUrl, mint.toBase58()], queryFn: () => loadPaused(connection, mint), refetchInterval: config.refreshMs });
  const register = useQuery({ queryKey: ["register", config.rpcUrl, l.address.toBase58()], queryFn: () => loadRegister(connection, l), refetchInterval: config.refreshMs });
  const frozen = (register.data ?? []).filter((w) => w.frozen);
  const frozenPages = usePages(frozen, 10);
  const candidates = (register.data ?? []).filter((w) => !w.frozen && !w.owner.equals(l.issuer));
  const picked = candidates.find((w) => w.owner.toBase58() === pick);
  const busy = tx.phase.kind === "busy";

  const confirm = async () => {
    if (!pending || !publicKey) return;
    const p = pending;
    const ok = await tx.run(() => [
      "wallet" in p ? freezeInstruction(mint, publicKey, p.wallet, p.kind === "freeze") : pauseInstruction(mint, publicKey, p.kind === "pause"),
    ]);
    if (ok) { setPending(null); setPick(""); }
  };

  const dialog = pending && (() => {
    switch (pending.kind) {
      case "pause": return { title: `Pause all ${sym} transfers?`, action: "Pause transfers", danger: true, points: [`Approved holders can no longer move or redeem ${sym}.`, `Buyers see “The issuer has paused transfers”.`, `${wsym} still trades on the pool.`, "You can resume at any time here."] };
      case "resume": return { title: `Resume ${sym} transfers?`, action: "Resume transfers", danger: false, points: ["Holders can move and redeem again straight away."] };
      case "freeze": return { title: `Freeze ${shortAddress(pending.wallet.toBase58())}?`, action: "Freeze holder", danger: true, points: [`This wallet’s ${sym} stops moving. Nobody else is affected.`, "It can’t redeem or deposit until you unfreeze it.", `It can still trade ${wsym}.`] };
      case "unfreeze": return { title: `Unfreeze ${shortAddress(pending.wallet.toBase58())}?`, action: "Unfreeze holder", danger: false, points: [`This wallet’s ${sym} can move again.`] };
    }
  })();

  return (
    <div className="flex max-w-4xl flex-col">
      <p className="flex items-center gap-1 pb-2 text-sm text-ink2">
        Every use is public.
        <Hint>These powers come with the security through Upside, as securities law requires. Your buyers see their effects on the asset page and the bridge as soon as they land.</Hint>
      </p>

      <Card title="Pause all transfers" hint={`For a regulatory hold. While paused, nobody can redeem or deposit; ${wsym} still trades on the pool.`}
        status={paused.data === undefined ? "…" : paused.data ? <span className="font-semibold text-amber">Paused</span> : <span className="text-green">Running</span>}>
        <div>
          {paused.data ? (
            <button type="button" disabled={busy} onClick={() => setPending({ kind: "resume" })} className="min-h-11 cursor-pointer bg-blue px-5 text-sm font-semibold text-white hover:bg-blue-deep disabled:opacity-50">Resume transfers…</button>
          ) : (
            <button type="button" disabled={busy || paused.data === undefined} onClick={() => setPending({ kind: "pause" })} className="min-h-11 cursor-pointer border border-error px-5 text-sm font-semibold text-error hover:bg-error hover:text-white disabled:opacity-50">Pause transfers…</button>
          )}
        </div>
      </Card>

      <Card title="Freeze one holder" hint={`For a sanctioned or compromised wallet. Their ${sym} stops moving; nobody else is affected.`}
        status={register.data === undefined ? "…" : frozen.length ? <span className="font-semibold text-amber">{frozen.length} frozen</span> : <span className="text-mute">None frozen</span>}>
        {frozen.length > 0 && (
          <div className="flex flex-col">
          <ul className="flex flex-col border-t border-rule">
            {frozenPages.shown.map((w) => (
              <li key={w.owner.toBase58()} className="flex items-center justify-between gap-3 border-b border-rule py-2.5 text-sm">
                <a href={explorerUrl("address", w.owner.toBase58())} target="_blank" rel="noopener noreferrer" className="font-mono underline decoration-line underline-offset-2">{shortAddress(w.owner.toBase58())}</a>
                <span className="text-mute num">{formatUnits(w.security, l.decimals, { maxFraction: 2 })} {sym}</span>
                <button type="button" disabled={busy} onClick={() => setPending({ kind: "unfreeze", wallet: w.owner })} className="min-h-9 cursor-pointer border border-line px-3 hover:border-ink disabled:opacity-50">Unfreeze…</button>
              </li>
            ))}
          </ul>
          <Pager p={frozenPages} noun="frozen wallets" compact />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="sr-only" htmlFor="freeze-pick">Holder to freeze</label>
          <select id="freeze-pick" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!candidates.length || busy}
            className="min-h-11 min-w-0 flex-1 border border-line bg-surface px-3 font-mono text-sm sm:max-w-sm">
            <option value="">{candidates.length ? "Choose a holder" : "No other holders on the register"}</option>
            {candidates.map((w) => <option key={w.owner.toBase58()} value={w.owner.toBase58()}>{shortAddress(w.owner.toBase58(), 6)} · {formatUnits(w.security, l.decimals, { maxFraction: 2 })} {sym}</option>)}
          </select>
          <button type="button" disabled={!picked || busy} onClick={() => picked && setPending({ kind: "freeze", wallet: picked.owner })}
            className="min-h-11 cursor-pointer border border-error px-5 text-sm font-semibold text-error hover:bg-error hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Freeze…</button>
        </div>
      </Card>

      <Card title="Moving or burning tokens" hint="Force transfer and burn exist in Upside for court orders. Aegis deliberately gives them no button. If they are ever used, including on the escrow, the backing check on every page shows it within seconds." status={<span className="text-mute">No button, on purpose</span>}>
        <span className="sr-only">Not available in Aegis.</span>
      </Card>

      {tx.phase.kind === "done" && !pending && (
        <p role="status" className="pop-in pt-4 text-sm text-green">Done. <a href={explorerUrl("tx", tx.phase.signature)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View the transaction ↗</a></p>
      )}

      {dialog && (
        <ConfirmDialog open title={dialog.title} points={dialog.points} symbol={sym} action={dialog.action} danger={dialog.danger} busy={busy}
          error={tx.phase.kind === "failed" ? <><strong className="text-error">{tx.phase.error.title}.</strong> <span className="text-ink2">{tx.phase.error.detail}</span></> : undefined}
          onConfirm={() => void confirm()} onClose={() => { if (!busy) { setPending(null); tx.reset(); } }} />
      )}
    </div>
  );
}
