import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState, type ReactNode } from "react";
import { config, explorerUrl } from "../../config";
import type { ConsoleLaunch } from "../../chain/console";
import { alreadyApproved, approvalBatch, approvalChunks, approvalDeposit, loadRegister } from "../../chain/investors";
import { TX_STEP, useTxRunner } from "../../hooks/useTxRunner";
import { LINE_NOTE, parseWalletLines } from "../../lib/addresses";
import { formatUnits, shortAddress } from "../../lib/amount";
import { PlainError } from "../../lib/txErrors";

const LAMPORTS = 1_000_000_000;

/** Approves wallets in as few signatures as fit, one transaction at a time, and reports progress. */
function useApprove(launch: ConsoleLaunch) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const tx = useTxRunner();
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const l = launch.entry.launch;

  const approve = async (wallets: PublicKey[]) => {
    if (!publicKey || !wallets.length) return false;
    const chunks = approvalChunks(l, publicKey, wallets);
    let ok = true;
    for (const [i, chunk] of chunks.entries()) {
      setProgress({ at: i + 1, of: chunks.length });
      ok = await tx.run(async () => {
        const done = await alreadyApproved(connection, l, chunk);
        const todo = chunk.filter((_, j) => !done[j]);
        if (!todo.length) throw new PlainError("Already approved", "These wallets are already on the register.");
        return approvalBatch(connection, l, publicKey, todo);
      });
      if (!ok) break;
      setApproved((prev) => [...prev, ...chunk.map(String)]);
    }
    setProgress(null);
    return ok;
  };
  return { approve, phase: tx.phase, progress, approved, reset: tx.reset };
}

function Section({ title, intro, children, id }: { title: string; intro?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-serif text-4xl">{title}</h2>
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
  if (phase.kind === "busy" && progress && progress.of > 1) return <p role="status" className="text-[13px] text-mute">Signature {progress.at} of {progress.of}: {TX_STEP[phase.step]}</p>;
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
    <Section id="waiting-h" title="Holders who can’t redeem yet" intro={<>These wallets hold {wsym} but are not approved, so they cannot exchange it for {sym}. Aegis finds them on-chain. It does not check anyone’s identity for you: <strong>approve a wallet only after your own KYC.</strong></>}>
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
  const [text, setText] = useState("");
  const flow = useApprove(launch);
  const fieldId = useId();
  const known = useMemo(() => new Set(launch.waiting.map((w) => w.owner.toBase58())), [launch.waiting]);
  const lines = useMemo(() => parseWalletLines(text, known, registered), [text, known, registered]);
  const ready = lines.flatMap((l) => (l.kind === "ready" ? [l.wallet] : []));
  const deposit = useQuery({ queryKey: ["approval-deposit", config.rpcUrl], queryFn: () => approvalDeposit(connection), staleTime: Infinity });
  const { publicKey } = useWallet();
  const signatures = publicKey && ready.length ? approvalChunks(launch.entry.launch, publicKey, ready).length : 0;
  const perWallet = deposit.data !== undefined ? Number(deposit.data) / LAMPORTS : null;

  return (
    <Section id="paste-h" title="Approve wallets you’ve already checked" intro="For investors who passed your KYC before buying. Paste one address per line; a spreadsheet column or a CSV with the address first works too.">
      <label htmlFor={fieldId} className="text-[13px] font-semibold">Wallet addresses, one per line</label>
      <textarea
        id={fieldId}
        value={text}
        onChange={(e) => { setText(e.target.value); if (flow.phase.kind !== "busy") flow.reset(); }}
        rows={5}
        spellCheck={false}
        autoComplete="off"
        placeholder="Paste Solana wallet addresses"
        className="w-full max-w-3xl border border-line bg-surface p-3 font-mono text-sm leading-relaxed outline-none focus:border-ink"
      />
      {lines.length > 0 && (
        <ul aria-label="What will happen to each line" className="flex max-w-3xl flex-col gap-1 font-mono text-[13px]">
          {lines.map((l) => (
            <li key={l.line} className={l.kind === "ready" ? "text-green" : l.kind === "invalid" || l.kind === "program" ? "text-error" : "text-mute"}>
              {l.kind === "ready" ? "✓" : l.kind === "invalid" || l.kind === "program" ? "✕" : "–"} line {l.line} · {LINE_NOTE[l.kind]}
            </li>
          ))}
        </ul>
      )}
      <div className="flex max-w-3xl flex-wrap items-center justify-between gap-3 pt-1">
        <span className="text-[13px] text-mute">
          {ready.length
            ? <>{ready.length} new {ready.length === 1 ? "wallet" : "wallets"} · {signatures} {signatures === 1 ? "signature" : "signatures"}{perWallet !== null && <> · each approval holds about {perWallet.toFixed(4)} SOL as Solana’s account deposit, paid by you</>}</>
            : "Nothing to approve yet"}
        </span>
        <button type="button" disabled={!ready.length || flow.phase.kind === "busy"} onClick={() => void flow.approve(ready).then((ok) => ok && setText(""))} className={primary}>
          {buttonLabel(flow.phase, ready.length ? `Approve ${ready.length} ${ready.length === 1 ? "wallet" : "wallets"}` : "Approve")}
        </button>
      </div>
      <Feedback phase={flow.phase} progress={flow.progress} doneText="Approved and added to the register." />
    </Section>
  );
}

function Register({ launch, register }: { launch: ConsoleLaunch; register: ReturnType<typeof useRegister> }) {
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto_5rem] gap-4 border-b border-ink py-2.5 font-mono text-xs tracking-[0.04em] text-mute">
            <span>WALLET</span><span className="text-right">HOLDS {sym}</span><span className="text-right">STATUS</span>
          </div>
          {shown.length === 0 ? (
            <p className="py-4 text-sm text-mute">{find ? "No approved wallet matches." : "No one is approved yet."}</p>
          ) : (
            <ul>
              {shown.slice(0, LIMIT).map((w) => {
                const k = w.owner.toBase58();
                return (
                  <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto_5rem] items-center gap-4 border-b border-rule py-3 text-sm">
                    <a href={explorerUrl("address", k)} target="_blank" rel="noopener noreferrer" title={k} className="font-mono underline decoration-line underline-offset-2 hover:decoration-ink">
                      {shortAddress(k)}{launch.entry.launch.issuer.equals(w.owner) && <span className="ml-2 font-sans text-xs text-mute no-underline">(you)</span>}
                    </a>
                    <span className="text-right num">{formatUnits(w.security, launch.entry.launch.decimals, { maxFraction: 2, minFraction: 2 })}</span>
                    <span className={`text-right text-[13px] ${w.frozen ? "text-error" : "text-green"}`}>{w.frozen ? "Frozen" : "Active"}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {shown.length > LIMIT && <p className="pt-3 text-[13px] text-mute">Showing {LIMIT} of {shown.length}. Search to find a wallet.</p>}
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
    <div className="grid grid-cols-1 gap-12 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 flex-col gap-14">
        <OwnWallet launch={launch} />
        <Waiting launch={launch} />
        <Paste launch={launch} registered={registered} />
        <Register launch={launch} register={register} />
      </div>
      <aside aria-labelledby="approval-h" className="flex h-fit flex-col gap-3 border border-ink bg-surface p-6">
        <h2 id="approval-h" className="text-[17px] font-semibold">What approval changes</h2>
        <ul className="flex flex-col text-sm leading-relaxed text-ink2">
          <li className="border-b border-track py-3">Approved wallets can hold {sym}, exchange {wsym} for {sym}, and exchange back.</li>
          <li className="border-b border-track py-3">Everyone else can still buy, sell and hold {wsym}. Approval is never needed to trade the wrapper.</li>
          <li className="border-b border-track py-3">Approvals are written to Upside’s register for {sym}, which you control. Aegis only reads it.</li>
          <li className="py-3">The group was fixed as Investors when you funded the escrow. Redemptions only ever go to that group.</li>
        </ul>
      </aside>
    </div>
  );
}
