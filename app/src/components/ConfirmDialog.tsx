import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A legal power never runs on one click: this dialog says who is affected and asks for the asset's
 * symbol before the action button unlocks. Built on <dialog>, so focus and Escape work natively.
 */
export function ConfirmDialog({ open, title, points, symbol, action, danger = true, busy, error, onConfirm, onClose }: {
  open: boolean;
  title: string;
  points: ReactNode[];
  symbol: string;
  action: string;
  danger?: boolean;
  busy: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setTyped(""); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);
  const ok = typed.trim().toUpperCase() === symbol.toUpperCase();

  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault(); }} aria-labelledby={`${inputId}-t`}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] border border-ink bg-surface p-0 text-ink backdrop:bg-ink/40">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (ok && !busy) onConfirm(); }} className="flex flex-col gap-4 p-6">
        <h2 id={`${inputId}-t`} className="font-serif text-3xl">{title}</h2>
        <ul className="flex flex-col gap-1.5 text-[15px] leading-relaxed text-ink2">
          {points.map((p, i) => <li key={i} className="flex gap-2"><span aria-hidden="true" className="text-mute">·</span><span>{p}</span></li>)}
        </ul>
        <label htmlFor={inputId} className="text-sm font-semibold">Type <span className="font-mono">{symbol}</span> to confirm</label>
        <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy}
          className="min-h-12 border border-line bg-paper px-3 font-mono uppercase outline-none focus:border-ink" />
        {error && <div role="alert" className="text-sm">{error}</div>}
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-11 cursor-pointer border border-line px-5 text-sm hover:border-ink disabled:opacity-50">Cancel</button>
          <button type="submit" disabled={!ok || busy}
            className={`min-h-11 cursor-pointer px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${danger ? "bg-error" : "bg-blue hover:bg-blue-deep"}`}>
            {busy ? "Approve in your wallet…" : action}
          </button>
        </div>
      </form>
    </dialog>
  );
}
