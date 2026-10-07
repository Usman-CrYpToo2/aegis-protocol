import { useEffect, useState } from "react";
import { cancelWalletWaits, useWalletWaitingSince } from "../lib/walletWait";

/** How long a wallet gets to open its approval window before the page offers help. */
const SLOW_MS = 10_000;

/**
 * Shown when the page has been waiting on the wallet for a while. Usually the person is simply
 * reading; sometimes the wallet extension lost its link to the page and no window ever opened.
 * Either way they get a way out.
 */
export function WalletWaitNotice() {
  const since = useWalletWaitingSince();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [since]);
  if (since === null || now - since < SLOW_MS) return null;
  return (
    <div role="alert" className="pop-in fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-xl flex-col gap-3 border border-ink bg-surface p-5 shadow-[0_12px_32px_rgb(22_20_15/0.18)] sm:inset-x-auto sm:right-6 sm:left-6">
      <strong className="text-[15px]">Waiting for your wallet</strong>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[14px] leading-relaxed text-ink2">
        {/* Observed with Phantom: in Chrome's side panel, approval requests can take minutes to
            appear; as a popup they open at once. */}
        <li><strong className="text-ink">Wallet open in the browser’s side panel?</strong> Close the side panel: the approval then opens in its own window straight away.</li>
        <li>No window at all? Click your wallet’s icon in the browser toolbar.</li>
        <li>Still nothing? The wallet extension may have lost its link to this page: cancel and reload.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={cancelWalletWaits} className="min-h-11 cursor-pointer border border-ink px-5 text-sm font-semibold hover:bg-paper">
          Cancel
        </button>
        <button type="button" onClick={() => { cancelWalletWaits(); window.location.reload(); }} className="min-h-11 cursor-pointer bg-ink px-5 text-sm font-semibold text-paper hover:bg-ink2">
          Cancel and reload
        </button>
      </div>
    </div>
  );
}
