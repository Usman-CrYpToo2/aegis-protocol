import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// ------------------------------------------------------------------------------------------------
// Context: one place that opens the dialog and hears about connection errors.
// ------------------------------------------------------------------------------------------------

type ConnectUI = { open: () => void; close: () => void; reportError: (message: string) => void };
const Ctx = createContext<ConnectUI | null>(null);

export function useConnectModal(): ConnectUI {
  const value = useContext(Ctx);
  if (!value) throw new Error("useConnectModal must be used inside <ConnectModalProvider>");
  return value;
}

/** Popular Solana wallets, offered when a browser has none of them. Links go to official sites. */
const POPULAR = [
  { name: "Phantom", site: "https://phantom.com/", deepLink: (url: string) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}` },
  { name: "Solflare", site: "https://solflare.com/", deepLink: (url: string) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}` },
  { name: "Backpack", site: "https://backpack.app/", deepLink: null },
] as const;

const isMobile = () => typeof navigator !== "undefined" && /android|iphone|ipad|ipod/i.test(navigator.userAgent);

/** A wallet's icon is supplied by the wallet itself; only images are accepted. */
const safeIcon = (icon: string | undefined) => (icon && /^(data:image\/(svg\+xml|png|webp|jpeg);|https:\/\/)/i.test(icon) ? icon : null);

function Spinner() {
  return <span className="size-4 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" />;
}

// ------------------------------------------------------------------------------------------------
// The dialog
// ------------------------------------------------------------------------------------------------

function ConnectDialog({ onClose, error, clearError }: { onClose: () => void; error: string | null; clearError: () => void }) {
  const { wallets, wallet, select, connect, connecting, connected } = useWallet();
  const [picked, setPicked] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  // Detected wallets first, the last one used on top.
  const lastUsed = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("walletName") ?? "null") as string | null;
    } catch {
      return null;
    }
  }, []);
  const detected = wallets
    .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
    .sort((a, b) => Number(b.adapter.name === lastUsed) - Number(a.adapter.name === lastUsed));
  const missing = POPULAR.filter((p) => !detected.some((w) => w.adapter.name === p.name));
  const mobile = isMobile();

  // Close once connected; the header then shows the account.
  useEffect(() => {
    if (connected && picked) onClose();
  }, [connected, picked, onClose]);

  // Focus: into the dialog on open, back to whatever opened it on close. Escape closes; Tab stays inside.
  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  const choose = useCallback(
    async (name: WalletName) => {
      clearError();
      setPicked(name);
      // Selecting a new wallet connects it (autoConnect); re-picking the selected one needs connect().
      if (wallet?.adapter.name === name) {
        try {
          await connect();
        } catch {
          // reported through the provider's onError
        }
      } else {
        select(name);
      }
    },
    [clearError, connect, select, wallet]
  );

  const busy = (name: string) => picked === name && connecting;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        onClick={(e) => e.stopPropagation()}
        className="connect-sheet flex max-h-[90dvh] w-full flex-col overflow-y-auto border-t border-ink bg-surface pb-[max(16px,env(safe-area-inset-bottom))] shadow-[0_-12px_32px_rgb(22_20_15/0.18)] sm:max-w-md sm:border sm:pb-0 sm:shadow-[0_12px_32px_rgb(22_20_15/0.18)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-rule px-6 pt-6 pb-4">
          <div className="flex flex-col gap-1">
            <h2 id="connect-title" className="font-serif text-3xl leading-tight">Connect a wallet</h2>
            <p className="text-sm text-ink2">Aegis never sees your keys. Your wallet asks you before anything is signed.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mt-2 -mr-3 flex min-h-11 min-w-11 cursor-pointer items-center justify-center text-mute hover:text-ink">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {detected.length > 0 && (
          <section aria-label="Wallets in this browser" className="flex flex-col px-3 py-3">
            {detected.map((w) => {
              const icon = safeIcon(w.adapter.icon);
              const name = w.adapter.name;
              return (
                <button
                  key={name}
                  type="button"
                  disabled={connecting}
                  onClick={() => void choose(name)}
                  className="group flex min-h-16 cursor-pointer items-center gap-4 rounded-sm px-3 text-left hover:bg-paper disabled:cursor-wait"
                >
                  {icon ? <img src={icon} alt="" width={36} height={36} className="size-9 rounded-md" /> : <span className="size-9 rounded-md bg-track" aria-hidden="true" />}
                  <span className="flex flex-1 flex-col">
                    <span className="text-[15px] font-semibold">{name}</span>
                    <span className="text-xs text-mute">{busy(name) ? "Check your wallet to approve…" : name === lastUsed ? "Last used" : "Detected"}</span>
                  </span>
                  {busy(name) ? (
                    <Spinner />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-mute transition-transform group-hover:translate-x-0.5" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
                  )}
                </button>
              );
            })}
          </section>
        )}

        {error && (
          <div role="alert" className="mx-6 mb-3 border border-error px-3 py-2 text-[13px] leading-relaxed text-error">
            {error}
          </div>
        )}

        {detected.length === 0 && (
          <p className="px-6 pt-5 text-[15px] leading-relaxed text-ink2">
            {mobile ? "Open Aegis inside your wallet app to connect, or install one first." : "No Solana wallet was found in this browser. Browsing needs nothing; to buy or exchange, install one, then press Connect again."}
          </p>
        )}

        {missing.length > 0 && (
          <section aria-label={detected.length ? "Other wallets" : "Get a wallet"} className="flex flex-col border-t border-rule px-6 py-4">
            <span className="kicker mb-2">{detected.length ? "Other wallets" : mobile ? "Open in a wallet app" : "Get a wallet"}</span>
            {missing.map((p) => {
              const link = mobile && p.deepLink ? p.deepLink(location.href) : p.site;
              return (
                <a key={p.name} href={link} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-between border-b border-rule text-[15px] last:border-b-0 hover:text-blue">
                  {p.name}
                  <span className="text-sm text-mute">{mobile && p.deepLink ? "Open ↗" : "Install ↗"}</span>
                </a>
              );
            })}
          </section>
        )}

        <p className="border-t border-rule bg-paper px-6 py-3 text-xs leading-relaxed text-mute">
          New to wallets? A wallet holds your tokens and signs your trades. It is yours alone; nobody at Aegis can move what is in it.
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Provider
// ------------------------------------------------------------------------------------------------

export function ConnectModalProvider({ children, errorRef }: { children: ReactNode; errorRef: { current: ((message: string) => boolean) | null } }) {
  const [isOpen, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(() => { setError(null); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);
  const reportError = useCallback((message: string) => setError(message), []);

  // While the dialog is open, connection errors show inside it rather than as a toast.
  useEffect(() => {
    errorRef.current = isOpen ? (message) => { setError(message); return true; } : null;
  }, [isOpen, errorRef]);

  const value = useMemo(() => ({ open, close, reportError }), [open, close, reportError]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {isOpen && <ConnectDialog onClose={close} error={error} clearError={() => setError(null)} />}
    </Ctx.Provider>
  );
}
