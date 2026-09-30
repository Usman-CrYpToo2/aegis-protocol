import { useEffect, useRef } from "react";

const WALLETS = [
  { name: "Phantom", url: "https://phantom.com/" },
  { name: "Solflare", url: "https://solflare.com/" },
  { name: "Backpack", url: "https://backpack.app/" },
];

/**
 * Shown instead of the adapter's own picker when the browser has no Solana wallet at all. That
 * picker offers nothing to click in that case, which leaves a first-time visitor stuck.
 */
export function NoWalletDialog({ onClose }: { onClose: () => void }) {
  const first = useRef<HTMLAnchorElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="no-wallet-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-5 border border-ink bg-surface p-6 shadow-[0_12px_32px_rgb(22_20_15/0.18)] sm:p-8"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="no-wallet-title" className="font-serif text-3xl leading-tight">No Solana wallet found</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-mt-2 -mr-3 min-h-11 min-w-11 cursor-pointer text-mute hover:text-ink">
            ✕
          </button>
        </div>
        <p className="text-[15px] leading-relaxed text-ink2">
          Browsing the registry needs nothing. To buy or exchange, install one of these wallets, then come back and press Connect again.
        </p>
        <ul className="flex flex-col border-t border-rule">
          {WALLETS.map((w, i) => (
            <li key={w.name} className="border-b border-rule">
              <a
                ref={i === 0 ? first : undefined}
                href={w.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-12 items-center justify-between text-[15px] font-medium hover:text-blue"
              >
                {w.name}
                <span className="text-sm text-mute">Install ↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
