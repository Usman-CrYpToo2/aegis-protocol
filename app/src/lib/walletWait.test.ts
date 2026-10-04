import { describe, expect, it } from "vitest";
import { cancelWalletWaits, trackWallet, WalletCancelledError } from "./walletWait";

describe("trackWallet", () => {
  it("passes the wallet's answer through", async () => {
    expect(await trackWallet(Promise.resolve("signed"))).toBe("signed");
    await expect(trackWallet(Promise.reject(new Error("User rejected")))).rejects.toThrow("User rejected");
  });

  it("gives up on request when cancelled, and ignores the wallet if it answers afterwards", async () => {
    let answer!: (v: string) => void;
    const waiting = trackWallet(new Promise<string>((r) => (answer = r)));
    cancelWalletWaits();
    await expect(waiting).rejects.toBeInstanceOf(WalletCancelledError);
    answer("signed too late"); // must not resurrect anything
    expect(await trackWallet(Promise.resolve("next"))).toBe("next");
  });
});
