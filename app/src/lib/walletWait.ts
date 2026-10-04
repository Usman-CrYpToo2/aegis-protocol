import { useSyncExternalStore } from "react";

/**
 * Every request the app makes to the wallet (approve one transaction, approve several) goes through
 * trackWallet, so the app knows when it is waiting on the wallet and for how long.
 *
 * A wallet extension can lose its connection to the page (its background worker restarts, or the
 * page outlived the extension's session). The request then never reaches the wallet: no window opens
 * and the page would wait forever. Tracking lets the page say so after a while, and cancelWalletWaits
 * lets the person give up: the waiting request is abandoned, so even if the wallet answers later,
 * nothing is sent.
 */

export class WalletCancelledError extends Error {
  readonly walletCancelled = true;
  constructor() {
    super("Cancelled while waiting for the wallet; nothing was sent.");
  }
}

const waiting = new Map<symbol, () => void>();
let since: number | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function trackWallet<T>(request: Promise<T>): Promise<T> {
  const id = Symbol("wallet");
  if (waiting.size === 0) since = Date.now();
  return new Promise<T>((resolve, reject) => {
    const settle = () => {
      if (!waiting.delete(id)) return false;
      if (waiting.size === 0) since = null;
      emit();
      return true;
    };
    waiting.set(id, () => { if (settle()) reject(new WalletCancelledError()); });
    emit();
    request.then(
      (v) => { if (settle()) resolve(v); },
      (e) => { if (settle()) reject(e); }
    );
  });
}

/** Abandons every request still waiting on the wallet. */
export function cancelWalletWaits() {
  for (const cancel of [...waiting.values()]) cancel();
}

/** When the oldest request still waiting on the wallet started, or null when none is. */
export function useWalletWaitingSince(): number | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => since,
    () => null
  );
}
