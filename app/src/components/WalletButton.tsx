import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useId, useRef, useState } from "react";
import { shortAddress } from "../lib/amount";
import { useIsIssuer } from "../hooks/useRegistry";
import { NoWalletDialog } from "./NoWalletDialog";

const base =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 px-4 text-sm transition-colors disabled:cursor-wait disabled:opacity-60";

export function WalletButton() {
  const { publicKey, connecting, disconnecting, disconnect, wallet, wallets } = useWallet();
  const { setVisible } = useWalletModal();
  const isIssuer = useIsIssuer();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [noWallet, setNoWallet] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Close on outside click and on Escape, returning focus to the button that opened it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => setOpen(false), [publicKey]);

  const hasWallet = wallets.some(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable
  );
  const openPicker = () => (hasWallet ? setVisible(true) : setNoWallet(true));

  if (!publicKey) {
    return (
      <>
        <button type="button" className={`${base} bg-ink font-semibold text-paper hover:bg-ink2`} disabled={connecting} onClick={openPicker}>
          {connecting ? `Connecting${wallet ? ` to ${wallet.adapter.name}` : ""}…` : "Connect wallet"}
        </button>
        {noWallet && <NoWalletDialog onClose={() => setNoWallet(false)} />}
      </>
    );
  }

  const address = publicKey.toBase58();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the full address is shown instead.
      setCopied(false);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className={`${base} border border-line bg-surface font-mono font-medium hover:border-ink`}
      >
        {shortAddress(address)}
        {isIssuer && <span className="bg-ink px-1.5 py-0.5 font-sans text-[11px] tracking-[0.08em] text-paper uppercase">Issuer</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={menuId} role="menu" className="absolute right-0 z-40 mt-2 w-72 border border-ink bg-surface shadow-[0_12px_32px_rgb(22_20_15/0.14)]">
          <div className="border-b border-rule px-4 py-3">
            <div className="kicker">Connected{wallet ? ` · ${wallet.adapter.name}` : ""}</div>
            <div className="mt-1 font-mono text-xs break-all text-ink2">{address}</div>
          </div>
          <button role="menuitem" type="button" onClick={copy} className="flex min-h-11 w-full cursor-pointer items-center px-4 text-left text-sm hover:bg-paper">
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); setVisible(true); }} className="flex min-h-11 w-full cursor-pointer items-center px-4 text-left text-sm hover:bg-paper">
            Change wallet
          </button>
          <button role="menuitem" type="button" disabled={disconnecting} onClick={() => void disconnect()} className="flex min-h-11 w-full cursor-pointer items-center border-t border-rule px-4 text-left text-sm text-error hover:bg-paper">
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
