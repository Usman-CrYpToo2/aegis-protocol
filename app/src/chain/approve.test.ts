import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAndSend, ApprovalTooSlowError } from "./approve";

const owner = Keypair.generate().publicKey;
const tx = () => ({ serialize: () => new Uint8Array([1]), sign: vi.fn() }) as never;

/** A connection with no nonce accounts, whose height climbs by `step` on every read. */
function chain({ start = 1_000, step = 0 } = {}) {
  let height = start;
  return {
    getMultipleAccountsInfo: vi.fn(async (keys: unknown[]) => keys.map(() => null)),
    getBlockHeight: vi.fn(async () => (height += step)),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] })),
    sendRawTransaction: vi.fn(async () => "sig"),
  } as never;
}

describe("approveAndSend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const run = async <T,>(p: Promise<T>) => { const settled = p.then((v) => v, (e) => e); await vi.runAllTimersAsync(); return settled; };

  it("sends at once when the approval comes back in time", async () => {
    const build = vi.fn(async () => ({ transaction: tx(), blockhash: "b", lastValidBlockHeight: 1_150 }));
    const wallet = { signTransaction: vi.fn(async (t: never) => t), sendTransaction: vi.fn() };
    expect(await run(approveAndSend(chain(), wallet as never, owner, build))).toBe("sig");
    expect(build).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
  });

  it("asks once more, with a fresh build, when the approval came back too late; nothing is sent first", async () => {
    let fresh = 0;
    const build = vi.fn(async () => ({ transaction: tx(), blockhash: "b", lastValidBlockHeight: fresh++ === 0 ? 1_000 : 2_000 }));
    const wallet = { signTransaction: vi.fn(async (t: never) => t), sendTransaction: vi.fn() };
    const conn = chain({ start: 1_000, step: 10 });
    const onRetry = vi.fn();
    expect(await run(approveAndSend(conn, wallet as never, owner, build, { onRetry }))).toBe("sig");
    expect(build).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect((conn as { sendRawTransaction: ReturnType<typeof vi.fn> }).sendRawTransaction.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("gives up after a second late approval, having sent nothing", async () => {
    const build = vi.fn(async () => ({ transaction: tx(), blockhash: "b", lastValidBlockHeight: 900 }));
    const wallet = { signTransaction: vi.fn(async (t: never) => t), sendTransaction: vi.fn() };
    const conn = chain();
    expect(await run(approveAndSend(conn, wallet as never, owner, build))).toBeInstanceOf(ApprovalTooSlowError);
    expect((conn as { sendRawTransaction: ReturnType<typeof vi.fn> }).sendRawTransaction).not.toHaveBeenCalled();
  });

  it("lets a wallet that can only send for itself send, and still confirms it", async () => {
    const build = vi.fn(async () => ({ transaction: tx(), blockhash: "b", lastValidBlockHeight: 1_150 }));
    const wallet = { sendTransaction: vi.fn(async () => "walletsig") };
    expect(await run(approveAndSend(chain(), wallet as never, owner, build))).toBe("walletsig");
  });
});
