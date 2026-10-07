import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { formatUnits, shortAddress } from "../lib/amount";
import { useIsIssuer } from "../hooks/useRegistry";
import { useConnectModal } from "./connect/ConnectModal";

const base =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 px-4 text-sm transition-colors disabled:cursor-wait disabled:opacity-60";

/** Only images are accepted as a wallet's icon; it is supplied by the wallet itself. */
const safeIcon = (icon: string | undefined) => (icon && /^(data:image\/(svg\+xml|png|webp|jpeg);|https:\/\/)/i.test(icon) ? icon : null);

export function WalletButton() {
  const { publicKey, connecting, disconnecting, disconnect, wallet } = useWallet();
  const { connection } = useConnection();
  const { open: openConnect } = useConnectModal();
  const isIssuer = useIsIssuer();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const sol = useQuery({
    queryKey: ["sol", config.rpcUrl, publicKey?.toBase58()],
    enabled: Boolean(publicKey) && open,
    queryFn: async () => BigInt(await connection.getBalance(publicKey!, "confirmed")),
  });

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

  if (!publicKey) {
    return (
      <button type="button" className={`${base} bg-ink font-semibold text-paper hover:bg-ink2`} disabled={connecting} onClick={openConnect}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  const address = publicKey.toBase58();
  const icon = safeIcon(wallet?.adapter.icon);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the full address is shown in the menu instead.
    }
  };

  const item = "flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 text-left text-sm hover:bg-paper";

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className={`${base} border border-line bg-surface pl-2 font-mono font-medium whitespace-nowrap hover:border-ink`}
      >
        {icon ? <img src={icon} alt="" width={22} height={22} className="size-5.5 rounded" /> : <span className="size-2 rounded-full bg-green" aria-hidden="true" />}
        {/* A phone's header is tight: a shorter address, and the role badge and arrow only from sm up. */}
        <span className="sm:hidden">{shortAddress(address, 3)}</span>
        <span className="hidden sm:inline">{shortAddress(address)}</span>
        {isIssuer && <span className="hidden bg-ink px-1.5 py-0.5 font-sans text-[11px] tracking-[0.08em] text-paper uppercase sm:inline">Issuer</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className={`hidden transition-transform sm:block ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={menuId} role="menu" className="menu-in absolute right-0 z-40 mt-2 w-76 border border-ink bg-surface shadow-[0_12px_32px_rgb(22_20_15/0.14)]">
          <div className="flex flex-col gap-1 border-b border-rule px-4 py-4">
            <div className="flex items-center gap-2">
              {icon && <img src={icon} alt="" width={20} height={20} className="size-5 rounded" />}
              <span className="kicker">{wallet?.adapter.name ?? "Wallet"} · {config.cluster}</span>
            </div>
            <span className="font-serif text-3xl num">
              {sol.data === undefined ? "—" : formatUnits(sol.data, 9, { maxFraction: 4 })} <span className="font-sans text-sm text-mute">SOL</span>
            </span>
            <span className="font-mono text-xs break-all text-ink2">{address}</span>
          </div>
          <Link role="menuitem" to="/holdings" onClick={() => setOpen(false)} className={item}>
            My holdings
          </Link>
          {isIssuer ? (
            <Link role="menuitem" to="/console" onClick={() => setOpen(false)} className={item}>
              Issuer console
            </Link>
          ) : (
            <Link role="menuitem" to="/launch" onClick={() => setOpen(false)} className={item}>
              Launch an asset
            </Link>
          )}
          <button role="menuitem" type="button" onClick={copy} className={item}>
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <a role="menuitem" href={explorerUrl("address", address)} target="_blank" rel="noopener noreferrer" className={item}>
            View on Explorer ↗<span className="sr-only"> (opens Solana Explorer)</span>
          </a>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); openConnect(); }} className={item}>
            Switch wallet
          </button>
          <button role="menuitem" type="button" disabled={disconnecting} onClick={() => void disconnect()} className={`${item} border-t border-rule text-error`}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
