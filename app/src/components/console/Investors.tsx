import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState, type ReactNode } from "react";
import { config, explorerUrl } from "../../config";
import type { ConsoleLaunch } from "../../chain/console";
import { alreadyApproved, approvalChunks, approvalDeposit, approvalTransactions, loadRegister } from "../../chain/investors";
import { TX_STEP, useTxRunner, type TxPhase } from "../../hooks/useTxRunner";
import { LINE_NOTE, parseWalletLines } from "../../lib/addresses";
import { formatUnits, shortAddress } from "../../lib/amount";
import { PlainError, explainTradeError } from "../../lib/txErrors";
import { removeInstruction } from "../../chain/powers";
import { ensureNonces, LAND_WITHIN_BLOCKS, NONCE_COUNT } from "../../chain/nonce";
import { sendSigned, withBackup } from "../../chain/send";
import { ConfirmDialog } from "../ConfirmDialog";
import { Hint } from "../Hint";

const LAMPORTS = 1_000_000_000;

/**
 * Approves any number of wallets with one wallet approval: every transaction is built up front,
 * signed together, then sent in order. Wallets already on the register are skipped first.
 */
function useApprove(launch: ConsoleLaunch) {
  const { connection } = useConnection();
  const { publicKey, signAllTransactions, signTransaction } = useWallet();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const l = launch.entry.launch;

  const approve = async (wallets: PublicKey[]) => {
    if (!publicKey || !wallets.length || phase.kind === "busy") return false;
    try {
      setPhase({ kind: "busy", step: "checking" });
      const done = await alreadyApproved(connection, l, wallets);
      const todo = wallets.filter((_, i) => !done[i]);
      if (!todo.length) throw new PlainError("Already approved", "These wallets are already on the register.");
      // Several transactions in one approval can take a wallet longer to preview than a blockhash
      // lasts, so they carry durable nonces (chain/nonce), at most eight per approval. Issuers
      // already have their nonce accounts from launching, so this asks for nothing extra.
      const signAll = (txs: VersionedTransaction[]) => (signAllTransactions ? signAllTransactions(txs) : Promise.all(txs.map((x) => signTransaction!(x))));
      const chunks = approvalChunks(l, publicKey, todo);
      const total = chunks.length;
      let signature = "";
      let sent = 0;
      for (let at = 0; at < chunks.length; at += NONCE_COUNT) {
        const wallets_ = chunks.slice(at, at + NONCE_COUNT).flat();
        const nonces = await ensureNonces(connection, publicKey, signAll);
        const txs = await approvalTransactions(connection, l, publicKey, wallets_, nonces[0]!.value, nonces);
        const sim = await withBackup(connection, (c) => c.simulateTransaction(txs[0]!, { sigVerify: false, commitment: "confirmed" }));
        if (sim.value.err) throw Object.assign(new Error(JSON.stringify(sim.value.err)), { logs: sim.value.logs ?? [] });
        setPhase({ kind: "busy", step: "signing" });
        const signed = await signAll(txs);
        setPhase({ kind: "busy", step: "confirming" });
        for (const [i, x] of signed.entries()) {
          setProgress({ at: ++sent, of: total });
          const patience = (await withBackup(connection, (c) => c.getBlockHeight("confirmed"))) + LAND_WITHIN_BLOCKS;
          signature = await sendSigned(connection, x, patience, i === 0);
        }
      }
      setApproved((prev) => [...prev, ...wallets.map(String)]);
      setPhase({ kind: "done", signature });
      return true;
    } catch (e) {
      setPhase({ kind: "failed", error: explainTradeError(e) });
      return false;
    } finally {
      setProgress(null);
      for (const key of ["register", "console", "registry"]) void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  return { approve, phase, progress, approved, reset: () => setPhase({ kind: "idle" }) };
}

function Section({ title, intro, hint, children, id }: { title: string; intro?: ReactNode; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="flex items-center gap-2 font-serif text-4xl">{title}{hint && <Hint>{hint}</Hint>}</h2>
      {intro && <p className="max-w-3xl text-sm leading-relaxed text-ink2">{intro}</p>}
      {children}
    </section>
  );
}

function Feedback({ phase, progress, doneText }: { phase: ReturnType<typeof useApprove>["phase"]; progress: ReturnType<typeof useApprove>["progress"]; doneText: string }) {
  if (phase.kind === "failed") {
    return (
      <p role="alert" className="text-[13px] leading-relaxed">
        <strong className="text-error">{phase.error.title}.</strong> <span className="text-ink2">{phase.error.detail}</span>
      </p>
    );
  }
  if (phase.kind === "busy" && progress && progress.of > 1) return <p role="status" className="text-[13px] text-mute">Confirming {progress.at} of {progress.of}…</p>;
  if (phase.kind === "done") {
    return (
      <p role="status" className="text-[13px] text-green">
        {doneText} <a href={explorerUrl("tx", phase.signature)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">View the transaction ↗</a>
      </p>
    );
  }
  return null;
}

const buttonLabel = (phase: ReturnType<typeof useApprove>["phase"], idle: string) => (phase.kind === "busy" ? TX_STEP[phase.step] : idle);
const primary = "min-h-11 cursor-pointer bg-blue px-5 text-sm font-semibold text-white hover:bg-blue-deep disabled:cursor-not-allowed disabled:bg-blue/40";

function OwnWallet({ launch }: { launch: ConsoleLaunch }) {
  const { publicKey } = useWallet();
  const own = useApprove(launch);
  const sym = launch.entry.label?.symbol ?? "the security";
  if (launch.issuerApproved || own.approved.length) {
    return own.phase.kind === "done" ? <Feedback phase={own.phase} progress={null} doneText="Your wallet is on the register." /> : null;
  }
  return (
    <div className="flex flex-col gap-3 border border-amber bg-amber-wash p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <strong className="text-[15px]">Your own wallet is not on the register</strong>
        <p className="text-sm leading-relaxed text-ink2">
          {launch.unsold > 0n
            ? <>Until it is, your {formatUnits(launch.unsold, launch.entry.launch.decimals, { maxFraction: 2 })} unsold {sym} cannot be sent to you. This takes one signature.</>
            : <>It needs to be approved before it can hold {sym}. This takes one signature.</>}
        </p>
        <Feedback phase={own.phase} progress={null} doneText="" />
      </div>
      <button type="button" disabled={own.phase.kind === "busy"} onClick={() => void own.approve([publicKey!])} className={`${primary} shrink-0`}>
        {buttonLabel(own.phase, "Approve my wallet")}
      </button>
    </div>
  );
}

function Waiting({ launch }: { launch: ConsoleLaunch }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const flow = useApprove(launch);
  const wsym = launch.entry.wrapperLabel?.symbol ?? "the wrapper";
  const sym = launch.entry.label?.symbol ?? "the security";
  const waiting = launch.waiting.filter((w) => !flow.approved.includes(w.owner.toBase58()));
  const picked = waiting.filter((w) => selected.has(w.owner.toBase58()));
  const busy = flow.phase.kind === "busy";
  const allOn = waiting.length > 0 && picked.length === waiting.length;
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const copy = (k: string) => void navigator.clipboard?.writeText(k).then(() => { setCopied(k); setTimeout(() => setCopied(null), 1500); });

  return (
    <Section id="waiting-h" title="Holders who can’t redeem yet" intro={<>They hold {wsym} but can’t redeem it for {sym}. <strong>Approve only after your own KYC.</strong></>} hint="Aegis finds these wallets on-chain. It doesn’t check anyone’s identity for you.">
      {waiting.length === 0 ? (
        <p className="border border-rule bg-surface p-5 text-sm text-ink2">{flow.approved.length ? "Approved. Every holder can redeem now." : `No one is waiting. Every ${wsym} holder can redeem.`}</p>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-4 border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute sm:grid-cols-[28px_minmax(0,1fr)_14rem_12rem]">
            <input type="checkbox" aria-label="Select every waiting wallet" checked={allOn} disabled={busy} onChange={() => setSelected(allOn ? new Set() : new Set(waiting.map((w) => w.owner.toBase58())))} className="size-4 cursor-pointer accent-blue" />
            <span>WALLET</span><span className="text-right">HOLDS</span><span className="hidden sm:block" />
          </div>
          <ul>
            {waiting.map((w) => {
              const k = w.owner.toBase58();
              return (
                <li key={k} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-4 border-b border-rule py-3 sm:grid-cols-[28px_minmax(0,1fr)_14rem_12rem]">
                  <input type="checkbox" aria-label={`Select ${k}`} checked={selected.has(k)} disabled={busy} onChange={() => toggle(k)} className="size-4 cursor-pointer accent-blue" />
                  <a href={explorerUrl("address", k)} target="_blank" rel="noopener noreferrer" title={k} className="font-mono text-sm underline decoration-line underline-offset-2 hover:decoration-ink">{shortAddress(k)}</a>
                  <span className="text-right text-sm num">{formatUnits(w.wrapper, launch.entry.launch.decimals, { maxFraction: 2, minFraction: 2 })} <span className="font-mono text-xs text-mute">{wsym}</span></span>
                  <span className="col-span-3 flex justify-end gap-2 sm:col-span-1">
                    <button type="button" onClick={() => copy(k)} className="min-h-10 cursor-pointer border border-line px-3 text-[13px] hover:border-ink">{copied === k ? "Copied" : "Copy"}</button>
                    <button type="button" disabled={busy} onClick={() => void flow.approve([w.owner])} className="min-h-10 cursor-pointer border border-blue px-3 text-[13px] font-semibold text-blue hover:bg-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50">Approve</button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <span className="text-[13px] text-mute">{picked.length ? `${picked.length} selected` : "Select wallets to approve several at once"}</span>
            <button type="button" disabled={!picked.length || busy} onClick={() => void flow.approve(picked.map((w) => w.owner)).then((ok) => ok && setSelected(new Set()))} className={primary}>
              {buttonLabel(flow.phase, picked.length ? `Approve ${picked.length} ${picked.length === 1 ? "wallet" : "wallets"}` : "Approve selected")}
            </button>
          </div>
        </div>
      )}
      <Feedback phase={flow.phase} progress={flow.progress} doneText="Approved. They can redeem now." />
    </Section>
  );
}

function Paste({ launch, registered }: { launch: ConsoleLaunch; registered: Set<string> }) {
  const { connection } = useConnection();
  const [input, setInput] = useState("");
  const [list, setList] = useState<PublicKey[]>([]);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const flow = useApprove(launch);
  const fieldId = useId();
  const deposit = useQuery({ queryKey: ["approval-deposit", config.rpcUrl], queryFn: () => approvalDeposit(connection), staleTime: Infinity });
  const perWallet = deposit.data !== undefined ? Number(deposit.data) / LAMPORTS : null;
  const busy = flow.phase.kind === "busy";

  // Adds what was typed or pasted: one address, or several separated by lines, commas or spaces.
  const add = () => {
    const listed = new Set(list.map(String));
    const lines = parseWalletLines(input.replace(/[\s,;]+/g, "\n"), listed, registered);
    const ready = lines.flatMap((l) => (l.kind === "ready" ? [l.wallet] : []));
    const skipped = lines.filter((l) => l.kind !== "ready");
    if (ready.length) setList((prev) => [...prev, ...ready]);
    const why = (k: (typeof skipped)[number]["kind"]) => (k === "known" ? "already in your list" : LINE_NOTE[k]);
    setNote(skipped.length === 0 ? null
      : lines.length === 1 ? { text: `${why(skipped[0]!.kind)[0]!.toUpperCase()}${why(skipped[0]!.kind).slice(1)}.`, error: true }
        : { text: `Added ${ready.length}, skipped ${skipped.length}: ${[...new Set(skipped.map((l) => why(l.kind)))].join("; ")}.`, error: ready.length === 0 });
    if (ready.length || !skipped.length) setInput("");
    if (flow.phase.kind !== "busy") flow.reset();
  };

  return (
    <Section id="paste-h" title="Approve wallets you’ve already checked" hint="For investors who passed your KYC before buying. You can paste several addresses at once.">
      <div className="flex max-w-3xl flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-[13px] font-semibold">Wallet address</label>
        <div className="flex gap-2">
          <input id={fieldId} value={input} disabled={busy} spellCheck={false} autoComplete="off" placeholder="Paste a Solana wallet address"
            onChange={(e) => { setInput(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (input.trim()) add(); } }}
            aria-invalid={Boolean(note?.error)} aria-describedby={`${fieldId}-note`}
            className="min-h-11 min-w-0 flex-1 border border-line bg-surface px-3 font-mono text-sm outline-none focus:border-ink" />
          <button type="button" disabled={!input.trim() || busy} onClick={add} className="min-h-11 cursor-pointer border border-ink px-5 text-sm font-semibold hover:bg-paper disabled:cursor-not-allowed disabled:opacity-40">Add</button>
        </div>
        <p id={`${fieldId}-note`} aria-live="polite" className={`min-h-5 text-[13px] ${note?.error ? "text-error" : "text-ink2"}`}>{note?.text ?? ""}</p>
      </div>

      {list.length > 0 && (
        <ul aria-label="Wallets to approve" className="flex max-w-3xl flex-col border-t border-ink">
          {list.map((w, i) => (
            <li key={w.toBase58()} className="flex items-center justify-between gap-3 border-b border-rule py-2">
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-6 text-right font-mono text-xs text-mute">{i + 1}</span>
                <span className="truncate font-mono text-sm" title={w.toBase58()}>{w.toBase58()}</span>
              </span>
              <button type="button" disabled={busy} onClick={() => setList((prev) => prev.filter((x) => !x.equals(w)))} aria-label={`Remove ${w.toBase58()} from the list`}
                className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center text-lg text-mute hover:text-error disabled:opacity-40">×</button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-1 text-[13px] text-mute">
          {list.length ? <>{list.length} {list.length === 1 ? "wallet" : "wallets"} · one approval</> : "Add wallets to approve them together"}
          {list.length > 0 && perWallet !== null && <Hint>Each approval holds about {perWallet.toFixed(4)} SOL as Solana’s account deposit, paid by you.</Hint>}
        </span>
        <div className="flex gap-2">
          {list.length > 1 && <button type="button" disabled={busy} onClick={() => setList([])} className="min-h-11 cursor-pointer px-3 text-sm text-ink2 underline underline-offset-4 disabled:opacity-40">Clear</button>}
          <button type="button" disabled={!list.length || busy} onClick={() => void flow.approve(list).then((ok) => ok && setList([]))} className={primary}>
            {buttonLabel(flow.phase, list.length > 1 ? `Approve all ${list.length}` : "Approve")}
          </button>
        </div>
      </div>
      <Feedback phase={flow.phase} progress={flow.progress} doneText="Approved and added to the register." />
    </Section>
  );
}

function Register({ launch, register }: { launch: ConsoleLaunch; register: ReturnType<typeof useRegister> }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTxRunner();
  const [removing, setRemoving] = useState<PublicKey | null>(null);
  const [find, setFind] = useState("");
  const sym = launch.entry.label?.symbol ?? "the security";
  const all = register.data ?? [];
  const shown = find.trim() ? all.filter((w) => w.owner.toBase58().toLowerCase().includes(find.trim().toLowerCase())) : all;
  const LIMIT = 50;
  return (
    <Section id="register-h" title="The register">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] text-mute">{register.data ? `${all.length} approved ${all.length === 1 ? "wallet" : "wallets"} · the investor group` : "Reading the register…"}</span>
        <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a wallet" aria-label="Find a wallet" className="min-h-10 w-full border border-line bg-surface px-3 font-mono text-sm outline-none focus:border-ink sm:w-72" />
      </div>
      {register.isError ? (
        <p role="alert" className="text-sm text-error">The register couldn’t be read. It retries automatically.</p>
      ) : !register.data ? (
        <span aria-busy="true" className="h-32 animate-pulse bg-track/70" />
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_5rem_5.5rem] gap-4 border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute">
            <span>WALLET</span><span className="text-right">HOLDS {sym}</span><span className="text-right">STATUS</span><span />
          </div>
          {shown.length === 0 ? (
            <p className="py-4 text-sm text-mute">{find ? "No approved wallet matches." : "No one is approved yet."}</p>
          ) : (
            <ul>
              {shown.slice(0, LIMIT).map((w) => {
                const k = w.owner.toBase58();
                return (
                  <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto_5rem_5.5rem] items-center gap-4 border-b border-rule py-3 text-sm">
                    <a href={explorerUrl("address", k)} target="_blank" rel="noopener noreferrer" title={k} className="font-mono underline decoration-line underline-offset-2 hover:decoration-ink">
                      {shortAddress(k)}{launch.entry.launch.issuer.equals(w.owner) && <span className="ml-2 font-sans text-xs text-mute no-underline">(you)</span>}
                    </a>
                    <span className="text-right num">{formatUnits(w.security, launch.entry.launch.decimals, { maxFraction: 2, minFraction: 2 })}</span>
                    <span className={`text-right text-[13px] ${w.frozen ? "text-error" : "text-green"}`}>{w.frozen ? "Frozen" : "Active"}</span>
                    <span className="text-right">
                      {!launch.entry.launch.issuer.equals(w.owner) && (
                        <button type="button" onClick={() => { tx.reset(); setRemoving(w.owner); }} className="min-h-9 cursor-pointer px-2 text-[13px] text-error underline underline-offset-2">Remove…</button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {shown.length > LIMIT && <p className="pt-3 text-[13px] text-mute">Showing {LIMIT} of {shown.length}. Search to find a wallet.</p>}
          {removing && (
            <ConfirmDialog open title={`Remove ${shortAddress(removing.toBase58())}?`} symbol={launch.entry.label?.symbol ?? ""} action="Remove from register" busy={tx.phase.kind === "busy"}
              points={[`It can no longer receive ${sym} or redeem.`, `What it already holds stays with it. Freeze it to stop that moving.`]}
              error={tx.phase.kind === "failed" ? <><strong className="text-error">{tx.phase.error.title}.</strong> <span className="text-ink2">{tx.phase.error.detail}</span></> : undefined}
              onConfirm={() => void tx.run(async () => [await removeInstruction(connection, launch.entry.launch.realRwaMint, publicKey!, removing)]).then((sig) => { if (sig) setRemoving(null); })}
              onClose={() => { if (tx.phase.kind !== "busy") setRemoving(null); }} />
          )}
        </div>
      )}
    </Section>
  );
}

function useRegister(launch: ConsoleLaunch) {
  const { connection } = useConnection();
  const l = launch.entry.launch;
  return useQuery({
    queryKey: ["register", config.rpcUrl, l.address.toBase58()],
    queryFn: () => loadRegister(connection, l),
    refetchInterval: config.refreshMs,
  });
}

export function Investors({ launch }: { launch: ConsoleLaunch }) {
  const register = useRegister(launch);
  const registered = useMemo(() => new Set((register.data ?? []).map((w) => w.owner.toBase58())), [register.data]);
  const sym = launch.entry.label?.symbol ?? "the security";
  const wsym = launch.entry.wrapperLabel?.symbol ?? "the wrapper";
  return (
    <div className="flex max-w-5xl flex-col gap-14">
      <p className="flex items-center gap-1 text-sm text-ink2">
        Approved wallets can hold {sym} and redeem {wsym} for it.
        <Hint label="What approval changes">Everyone else can still buy, sell and hold {wsym}; approval is never needed to trade the wrapper. Approvals are written to Upside’s register for {sym}, which you control. Aegis only reads it, and redemptions only ever go to the Investors group.</Hint>
      </p>
      <OwnWallet launch={launch} />
      <Waiting launch={launch} />
      <Paste launch={launch} registered={registered} />
      <Register launch={launch} register={register} />
    </div>
  );
}
